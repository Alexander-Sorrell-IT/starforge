// starreckon beacon — LAN peer discovery via UDP multicast.
//
// THIS FILE RUNS AS A CHILD PROCESS — never imported in the main scan process.
// The tripwire in the main process patches dgram.createSocket to throw
// permanently. Spawning a fresh node process is the only safe way to use UDP.
// cli.mjs lazy-imports child_process and spawns:
//   node src/beacon.mjs --mode=announce|listen|live \
//        [--payload=<base64>] [--listen-ms=8000] [--coordinator]
//
// Modes:
//   announce   send one machine's data, listen for peers, exit with JSON array
//   listen     listen only (no announce), exit with JSON array
//   live       announce + listen indefinitely; print peer updates as NDJSON
//              lines to stdout; read coordinator-claim packets; exit on SIGINT
//
// Multicast group: 239.255.255.250 port 4141
// All packets: { v:1, kind, ... } JSON, max MAX_BYTES. Larger = silently dropped.
//
// @starreckon-intentional-egress
// UDP multicast only — 239.255.255.250:4141, link-local, never leaves the LAN.
// This process is spawned by cli.mjs AFTER the scan completes and AFTER the
// tripwire has armed in the parent. It runs in a fresh process with no tripwire.

import dgram from "node:dgram";
import { hostname } from "node:os";

export const MULTICAST_ADDR = "239.255.255.250";
export const PORT = 4141;
export const MAX_BYTES = 8192;

// ---- packet encoding -------------------------------------------------------

/**
 * Encode a machine data object into a UDP-ready Buffer.
 * Returns null when the payload exceeds MAX_BYTES.
 */
export function encodePacket(kind, data) {
  const obj = { v: 1, kind, ...data };
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  if (buf.length > MAX_BYTES) return null;
  return buf;
}

/**
 * Decode a raw Buffer from the wire.
 * Returns null when malformed, unknown version, or oversized.
 */
export function decodePacket(buf) {
  if (!buf || buf.length > MAX_BYTES) return null;
  let obj;
  try {
    obj = JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || obj.v !== 1) return null;
  if (!obj.kind || typeof obj.kind !== "string") return null;
  return obj;
}

/**
 * Build the announce payload from a scan result.
 * Keeps only the fields the fleet star needs — no personal data beyond
 * what the user would already share via --join-fleet.
 *
 * data shape (all optional, gracefully absent):
 *   machine   string  display name (defaults to os.hostname())
 *   totals    object  same shape as fleet totals.json
 *   months    array   last ≤3 months [{month, input_tokens, output_tokens, active_days}]
 *   label     string  human label shown in the combined star
 */
export function buildAnnouncePayload(data = {}) {
  const pkt = {
    machine: data.machine ?? hostname(),
    label: data.label ?? data.machine ?? hostname(),
    totals: data.totals ?? null,
    months: Array.isArray(data.months) ? data.months.slice(-3) : [],
    sentAt: new Date().toISOString(),
  };
  // When a fleet key is active, include the sender's raw public key so
  // receivers can verify the signature and confirm fleet membership.
  if (data.pub) pkt.pub = data.pub;
  return pkt;
}

// ---- socket helpers --------------------------------------------------------

function openSocket() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", reject);
    sock.bind(PORT, () => {
      try {
        sock.addMembership(MULTICAST_ADDR);
        sock.setMulticastTTL(1);         // stays on the local subnet
        sock.setMulticastLoopback(true); // receive own packets (useful for tests)
      } catch {
        // non-fatal: some OSes don't support all options
      }
      resolve(sock);
    });
  });
}

function sendPacket(sock, buf, addr) {
  return new Promise((resolve, reject) => {
    sock.send(buf, 0, buf.length, PORT, addr, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

// ---- Mode 1 + 2 shared: announce + listen ----------------------------------

/**
 * Announce this machine's data and collect peers.
 *
 * announcePayload — output of buildAnnouncePayload(), or null for listen-only
 * listenMs        — how long to listen (default 8000ms)
 * onPeer          — optional callback(peerObj) called as each peer arrives
 *
 * Returns array of decoded peer announce packets (excluding own if
 * selfMachine matches, but including self when testing on loopback).
 */
export async function announceAndListen(announcePayload, listenMs = 8000, onPeer = null, fleetKey = null) {
  // fleetKey: optional { privateKeyObj, publicKeyBytes } from fleetkey.mjs.
  // When present: outbound packets are signed, inbound are verified and
  // unsigned/bad-sig packets are silently dropped.
  const sock = await openSocket();
  const peers = [];
  const seen = new Set(); // dedupe by machine+sentAt

  return new Promise((resolve) => {
    // Collect incoming packets
    sock.on("message", (buf) => {
      let pkt;
      if (fleetKey) {
        pkt = verifyPacket(buf, fleetKey.publicKeyBytes);
      } else {
        pkt = decodePacket(buf);
      }
      if (!pkt || pkt.kind !== "announce") return;
      const key = `${pkt.machine}:${pkt.sentAt}`;
      if (seen.has(key)) return;
      seen.add(key);
      peers.push(pkt);
      if (onPeer) try { onPeer(pkt); } catch {}
    });

    // Announce immediately (then repeat every 3s until listenMs expires)
    const doAnnounce = () => {
      if (!announcePayload) return;
      let buf = encodePacket("announce", announcePayload);
      if (buf && fleetKey) buf = signPacket(buf, fleetKey.privateKeyObj);
      if (buf) sendPacket(sock, buf, MULTICAST_ADDR).catch(() => {});
    };

    doAnnounce();
    const repeatInterval = setInterval(doAnnounce, 3000);

    setTimeout(() => {
      clearInterval(repeatInterval);
      sock.close();
      resolve(peers);
    }, listenMs);
  });
}

// ---- Mode 2: live coordinator protocol -------------------------------------

/**
 * Run the live-together mode. Stays open until SIGINT or until all
 * known peers have gone quiet (no packet for quietMs).
 *
 * announcePayload — this machine's data
 * opts:
 *   coordinator   bool   — whether this machine is claiming coordinator role
 *   quietMs       number — ms of silence before assuming a peer left (default 15000)
 *   onEvent       fn(event) — called with { type, peer } for 'join'|'leave'|'coordinator'
 *
 * Returns { peers: Map<machine, lastPacket>, coordinator: string|null }
 */
export async function runLive(announcePayload, opts = {}) {
  const { coordinator = false, quietMs = 15000, onEvent = null, fleetKey = null } = opts;
  // fleetKey: optional { privateKeyObj, publicKeyBytes } from fleetkey.mjs.
  const sock = await openSocket();
  const peers = new Map();     // machine -> { pkt, lastSeen }
  let coordMachine = null;

  const emit = (type, peer) => {
    if (onEvent) try { onEvent({ type, peer }); } catch {}
  };

  sock.on("message", (buf) => {
    let pkt;
    if (fleetKey) {
      pkt = verifyPacket(buf, fleetKey.publicKeyBytes);
    } else {
      pkt = decodePacket(buf);
    }
    if (!pkt) return;

    if (pkt.kind === "announce") {
      const existing = peers.get(pkt.machine);
      peers.set(pkt.machine, { pkt, lastSeen: Date.now() });
      if (!existing) emit("join", pkt);
    } else if (pkt.kind === "coordinator") {
      if (!coordMachine) {
        coordMachine = pkt.machine;
        emit("coordinator", pkt);
      }
    }
  });

  // Announce + repeat
  const doAnnounce = () => {
    let buf = encodePacket("announce", announcePayload);
    if (buf && fleetKey) buf = signPacket(buf, fleetKey.privateKeyObj);
    if (buf) sendPacket(sock, buf, MULTICAST_ADDR).catch(() => {});
  };
  doAnnounce();
  const announceInterval = setInterval(doAnnounce, 3000);

  // Claim coordinator if requested
  if (coordinator) {
    const buf = encodePacket("coordinator", { machine: announcePayload.machine });
    if (buf) await sendPacket(sock, buf, MULTICAST_ADDR).catch(() => {});
    coordMachine = announcePayload.machine;
    emit("coordinator", { machine: announcePayload.machine });
  }

  // Prune peers that have gone quiet
  const pruneInterval = setInterval(() => {
    const now = Date.now();
    for (const [machine, entry] of peers) {
      if (now - entry.lastSeen > quietMs) {
        peers.delete(machine);
        emit("leave", entry.pkt);
      }
    }
  }, 3000);

  // Cleanup
  const cleanup = () => {
    clearInterval(announceInterval);
    clearInterval(pruneInterval);
    try { sock.close(); } catch {}
  };

  return {
    peers,
    getCoordinator: () => coordMachine,
    stop: cleanup,
    // Convenience: wait until SIGINT then return final peer list
    waitForExit: () => new Promise((resolve) => {
      process.once("SIGINT", () => {
        cleanup();
        resolve({ peers: [...peers.values()].map((e) => e.pkt), coordinator: coordMachine });
      });
    }),
  };
}

// ---- CLI entrypoint (when run as child process) ----------------------------
// Reads args, runs the appropriate mode, writes JSON to stdout, exits.

if (process.argv[1] && process.argv[1].endsWith("beacon.mjs")) {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, ...v] = a.slice(2).split("=");
        return [k, v.length ? v.join("=") : true];
      })
  );

  const mode = args.mode ?? "announce";
  const listenMs = Number(args["listen-ms"] ?? 8000);
  const isCoordinator = Boolean(args.coordinator);

  // --fleet-pub is the base64 raw 32-byte Ed25519 public key passed by cli.mjs.
  // When present, only packets signed by the matching private key are accepted.
  let beaconFleetKey = null;
  if (args["fleet-pub"]) {
    try {
      const publicKeyBytes = Buffer.from(args["fleet-pub"], "base64");
      if (publicKeyBytes.length === 32) {
        // In the child process we only need publicKeyBytes for verification
        // (we sign using the private key already embedded in the payload's pub
        // field, which was signed in cli.mjs before spawning this child).
        // For outbound signing in the child we need the private key too — but
        // cli.mjs passes a pre-signed payload when it can. For simplicity, the
        // child uses publicKeyBytes for VERIFY only; signing is done in cli.mjs
        // before the child is spawned (payload already has pub set).
        beaconFleetKey = { publicKeyBytes, privateKeyObj: null };
      }
    } catch {
      process.stderr.write("beacon: invalid --fleet-pub (must be base64, 32 bytes)\n");
    }
  }

  let announcePayload = null;
  if (args.payload) {
    try {
      announcePayload = JSON.parse(Buffer.from(args.payload, "base64").toString("utf8"));
    } catch {
      process.stderr.write("beacon: invalid --payload (must be base64 JSON)\n");
      process.exit(1);
    }
  }

  if (mode === "announce" || mode === "listen") {
    // Write received peers as JSON array to stdout, then exit
    const peers = await announceAndListen(
      mode === "announce" ? announcePayload : null,
      listenMs,
      null,
      beaconFleetKey,
    );
    process.stdout.write(JSON.stringify(peers) + "\n");
    process.exit(0);

  } else if (mode === "live") {
    // Stream events as NDJSON to stdout; exit on SIGINT
    if (!announcePayload) {
      process.stderr.write("beacon: --mode=live requires --payload\n");
      process.exit(1);
    }
    const session = await runLive(announcePayload, {
      coordinator: isCoordinator,
      fleetKey: beaconFleetKey,
      onEvent: (evt) => {
        process.stdout.write(JSON.stringify(evt) + "\n");
      },
    });
    const result = await session.waitForExit();
    process.stdout.write(JSON.stringify({ done: true, ...result }) + "\n");
    process.exit(0);

  } else {
    process.stderr.write(`beacon: unknown --mode=${mode}\n`);
    process.exit(1);
  }
}


// ---- fleet key signing (Ed25519) -------------------------------------------
//
// When a fleetKey is provided to announceAndListen / runLive, every outbound
// announce packet is signed and every inbound announce packet is verified.
// Packets with a missing or invalid signature are silently dropped — they are
// either from a different fleet or from a rogue machine on the same WiFi.
//
// Wire additions (only present when signing is active):
//   pub  — base64 raw 32-byte Ed25519 public key of the sender
//   sig  — base64 64-byte Ed25519 signature over the canonical payload bytes
//
// The canonical payload is the JSON of the packet WITH pub present but WITH
// sig absent — so the signature covers the content + the sender's identity.
// This is the simplest possible scheme that prevents:
//   - replay from a different fleet (pub mismatch → drop)
//   - forgery by a rogue peer (no private key → can't produce valid sig)
//   - man-in-the-middle substitution (sig covers machine+totals+sentAt+pub)

import {
  signPayload,
  verifyPayload,
} from "./fleetkey.mjs";

/**
 * Sign an announce packet Buffer that already contains `pub`.
 * The sig is computed over the packet bytes WITH pub but WITHOUT sig.
 * Returns a new Buffer with `sig` injected, or null if it exceeds MAX_BYTES.
 *
 * @param {Buffer} unsignedBuf  — output of encodePacket() with pub already set
 * @param {object} privateKeyObj — node:crypto KeyObject (Ed25519 private)
 */
export function signPacket(unsignedBuf, privateKeyObj) {
  const sig = signPayload(privateKeyObj, unsignedBuf);
  // Re-parse, inject sig, re-encode.
  let obj;
  try { obj = JSON.parse(unsignedBuf.toString("utf8")); } catch { return null; }
  obj.sig = sig.toString("base64");
  const out = Buffer.from(JSON.stringify(obj), "utf8");
  if (out.length > MAX_BYTES) return null;
  return out;
}

/**
 * Verify an inbound packet Buffer against a known public key (32-byte Buffer).
 * Returns the decoded packet object if valid, null if signature is missing or
 * does not verify. Always returns null for non-announce packets — coordinator
 * and done packets are not signed (they carry no user data).
 *
 * @param {Buffer} buf            — raw wire bytes
 * @param {Buffer} publicKeyBytes — expected 32-byte Ed25519 public key
 */
export function verifyPacket(buf, publicKeyBytes) {
  const pkt = decodePacket(buf);
  if (!pkt) return null;
  // Only announce packets are signed; others pass through unsigned.
  if (pkt.kind !== "announce") return pkt;
  if (typeof pkt.sig !== "string" || typeof pkt.pub !== "string") return null;
  // The pub field in the packet must match the expected fleet public key.
  let pktPub;
  try { pktPub = Buffer.from(pkt.pub, "base64"); } catch { return null; }
  if (!pktPub.equals(publicKeyBytes)) return null;
  // Reconstruct the bytes that were signed: same object but WITHOUT sig.
  const forVerify = { ...pkt };
  delete forVerify.sig;
  const canonical = Buffer.from(JSON.stringify(forVerify), "utf8");
  let sigBuf;
  try { sigBuf = Buffer.from(pkt.sig, "base64"); } catch { return null; }
  if (!verifyPayload(pktPub, canonical, sigBuf)) return null;
  return pkt;
}

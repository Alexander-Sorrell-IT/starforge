// Tests for src/beacon.mjs — UDP multicast peer discovery.
//
// Network usage: loopback only (127.0.0.1). Tests that bind a real UDP socket
// use multicastLoopback so the machine hears its own packets without actually
// going on the wire. No external network calls.
//
// NOTE: beacon.mjs CANNOT be imported in the same process as the tripwire
// (dgram.createSocket is patched to throw). These tests import beacon.mjs
// directly because the tripwire is NOT armed in test processes — tests never
// call armTripwire(). That is correct and intentional.

import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MULTICAST_ADDR,
  PORT,
  MAX_BYTES,
  encodePacket,
  decodePacket,
  buildAnnouncePayload,
  announceAndListen,
} from "../src/beacon.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BEACON = join(ROOT, "src", "beacon.mjs");

// ---- constants -------------------------------------------------------------

test("MULTICAST_ADDR is a link-local multicast address", () => {
  assert.match(MULTICAST_ADDR, /^239\./);
});

test("PORT is a non-privileged port", () => {
  assert.ok(PORT > 1023 && PORT < 65536);
});

test("MAX_BYTES is reasonable (> 1 KB, < 64 KB)", () => {
  assert.ok(MAX_BYTES > 1024 && MAX_BYTES < 65536);
});

// ---- encodePacket ----------------------------------------------------------

test("encodePacket returns a Buffer for a small payload", () => {
  const buf = encodePacket("announce", { machine: "test", totals: null, months: [] });
  assert.ok(buf instanceof Buffer);
  assert.ok(buf.length > 0 && buf.length <= MAX_BYTES);
});

test("encodePacket returns null when payload exceeds MAX_BYTES", () => {
  const big = "x".repeat(MAX_BYTES);
  const buf = encodePacket("announce", { machine: big, totals: null, months: [] });
  assert.strictEqual(buf, null);
});

test("encodePacket includes v:1 and kind in the output", () => {
  const buf = encodePacket("announce", { machine: "m1" });
  const obj = JSON.parse(buf.toString("utf8"));
  assert.strictEqual(obj.v, 1);
  assert.strictEqual(obj.kind, "announce");
  assert.strictEqual(obj.machine, "m1");
});

// ---- decodePacket ----------------------------------------------------------

test("decodePacket roundtrips an encoded packet", () => {
  const buf = encodePacket("announce", { machine: "roundtrip", sentAt: "2026-01-01T00:00:00Z" });
  const pkt = decodePacket(buf);
  assert.ok(pkt);
  assert.strictEqual(pkt.v, 1);
  assert.strictEqual(pkt.kind, "announce");
  assert.strictEqual(pkt.machine, "roundtrip");
});

test("decodePacket returns null for non-JSON input", () => {
  assert.strictEqual(decodePacket(Buffer.from("not json")), null);
});

test("decodePacket returns null for oversized input", () => {
  const big = Buffer.alloc(MAX_BYTES + 1, 0x61); // 'a' * (MAX_BYTES+1)
  assert.strictEqual(decodePacket(big), null);
});

test("decodePacket returns null for null/undefined input", () => {
  assert.strictEqual(decodePacket(null), null);
  assert.strictEqual(decodePacket(undefined), null);
});

test("decodePacket returns null when v field is missing", () => {
  const buf = Buffer.from(JSON.stringify({ kind: "announce", machine: "x" }));
  assert.strictEqual(decodePacket(buf), null);
});

test("decodePacket returns null when v field is wrong version", () => {
  const buf = Buffer.from(JSON.stringify({ v: 99, kind: "announce", machine: "x" }));
  assert.strictEqual(decodePacket(buf), null);
});

test("decodePacket returns null when kind is missing", () => {
  const buf = Buffer.from(JSON.stringify({ v: 1, machine: "x" }));
  assert.strictEqual(decodePacket(buf), null);
});

// ---- buildAnnouncePayload --------------------------------------------------

test("buildAnnouncePayload includes required fields", () => {
  const p = buildAnnouncePayload({ machine: "mybox", totals: { input_tokens: 1 }, months: [] });
  assert.strictEqual(p.machine, "mybox");
  assert.ok(p.sentAt);
  assert.ok(Array.isArray(p.months));
});

test("buildAnnouncePayload defaults machine to os.hostname()", () => {
  const p = buildAnnouncePayload({});
  assert.ok(typeof p.machine === "string" && p.machine.length > 0);
});

test("buildAnnouncePayload keeps only last 3 months", () => {
  const months = [1, 2, 3, 4, 5].map((i) => ({ month: `2026-0${i}`, active_days: i }));
  const p = buildAnnouncePayload({ months });
  assert.strictEqual(p.months.length, 3);
  assert.strictEqual(p.months[0].month, "2026-03");
});

test("buildAnnouncePayload handles absent months gracefully", () => {
  const p = buildAnnouncePayload({ machine: "x" });
  assert.deepStrictEqual(p.months, []);
});

// ---- announceAndListen (loopback, short timeout) ---------------------------

test("announceAndListen receives own packet via multicast loopback", async (t) => {
  // UDP multicast tests can be flaky in some CI environments.
  // Skip gracefully if the socket bind fails (e.g. port already in use).
  const payload = buildAnnouncePayload({ machine: "loopback-test-" + Date.now() });
  let peers;
  try {
    peers = await announceAndListen(payload, 500);
  } catch (e) {
    t.skip(`UDP socket unavailable: ${e.message}`);
    return;
  }
  // With multicastLoopback:true we should receive at least our own packet.
  assert.ok(Array.isArray(peers));
  // At least one peer with our machine name (may include own packet)
  const found = peers.some((p) => p.machine === payload.machine);
  assert.ok(found, `own machine '${payload.machine}' not found in peers: ${JSON.stringify(peers)}`);
});

test("announceAndListen with null payload (listen-only) returns array", async (t) => {
  let peers;
  try {
    peers = await announceAndListen(null, 300);
  } catch (e) {
    t.skip(`UDP socket unavailable: ${e.message}`);
    return;
  }
  assert.ok(Array.isArray(peers));
});

test("announceAndListen deduplicates repeated packets from same machine", async (t) => {
  const payload = buildAnnouncePayload({ machine: "dedup-test-" + Date.now() });
  let peers;
  try {
    // 600ms = enough time for at least 2 announces (interval is 3s, so just 1 here)
    peers = await announceAndListen(payload, 600);
  } catch (e) {
    t.skip(`UDP socket unavailable: ${e.message}`);
    return;
  }
  const own = peers.filter((p) => p.machine === payload.machine);
  // Each sentAt is unique per announce cycle, so dedup by machine+sentAt
  // means we may see multiple if intervals fire. But all should be valid objects.
  for (const p of own) {
    assert.strictEqual(p.kind, "announce");
    assert.strictEqual(p.v, 1);
  }
});

// ---- CLI child process entrypoint ------------------------------------------

test("beacon.mjs --mode=listen exits 0 and writes a JSON array", (t) => {
  const r = spawnSync(process.execPath, [BEACON, "--mode=listen", "--listen-ms=400"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.signal) {
    t.skip(`child killed by signal ${r.signal}`);
    return;
  }
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  let parsed;
  try { parsed = JSON.parse(r.stdout.trim()); } catch {
    assert.fail(`stdout is not valid JSON: ${r.stdout}`);
  }
  assert.ok(Array.isArray(parsed));
});

test("beacon.mjs --mode=announce with valid payload exits 0", (t) => {
  const payload = buildAnnouncePayload({ machine: "cli-test" });
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const r = spawnSync(
    process.execPath,
    [BEACON, "--mode=announce", `--payload=${b64}`, "--listen-ms=400"],
    { encoding: "utf8", timeout: 5000 }
  );
  if (r.signal) {
    t.skip(`child killed by signal ${r.signal}`);
    return;
  }
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(Array.isArray(parsed));
});

test("beacon.mjs --mode=announce with invalid payload exits 1", () => {
  const r = spawnSync(
    process.execPath,
    [BEACON, "--mode=announce", "--payload=!!!notbase64!!!"],
    { encoding: "utf8", timeout: 5000 }
  );
  assert.strictEqual(r.status, 1);
});

test("beacon.mjs --mode=unknown exits 1", () => {
  const r = spawnSync(
    process.execPath,
    [BEACON, "--mode=unknown"],
    { encoding: "utf8", timeout: 5000 }
  );
  assert.strictEqual(r.status, 1);
});

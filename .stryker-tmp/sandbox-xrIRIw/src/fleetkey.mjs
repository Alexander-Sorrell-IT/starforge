// @ts-nocheck
// starreckon fleet key — Ed25519 identity for LAN peer authentication.
//
// Every machine in your fleet shares a fleet identity: a single Ed25519
// key pair stored at ~/.starreckon/fleet.key (JSON, private + public).
// Copy this file to each machine by hand (or via --join-fleet) to form
// a trusted group. Machines without the matching private key cannot
// produce a valid signature, so rogue peers on the same WiFi are silently
// ignored — their announce packets fail verification and are dropped.
//
// WHAT THIS FILE DOES:
//   - generates a new key pair on first run (generateKeyPairSync, Ed25519)
//   - saves it to ~/.starreckon/fleet.key  (mode 0600 — owner-read-only)
//   - loads and validates it on subsequent runs
//   - signs arbitrary Buffer payloads with the private key
//   - verifies a signature against a raw public key bytes (32-byte seed)
//
// WHAT THIS FILE DOES NOT DO:
//   - No network of any kind
//   - No child_process
//   - No writes other than ~/.starreckon/fleet.key (owner-only, created once)
//
// The public key is broadcast in every announce packet as a 32-byte
// base64 string (the Ed25519 raw public key, not the SPKI envelope).
// Peers that share the same fleet identity will have the same public key
// on disk; they accept only packets whose signature verifies against that
// public key. A machine with a different fleet.key (or none) will produce
// a different public key and a different signature — both checks fail.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";

export const KEY_FILENAME = "fleet.key";

export function keyPath(home) {
  return join(home ?? homedir(), ".starreckon", KEY_FILENAME);
}

/**
 * Load the fleet key from disk, generating it if it does not exist yet.
 * Returns { privateKeyObj, publicKeyBytes } where publicKeyBytes is a
 * 32-byte Buffer (raw Ed25519 public key, no envelope).
 * Never throws on a normal first run. Throws only on a corrupt key file.
 */
export function loadOrCreateFleetKey(home) {
  const file = keyPath(home ?? homedir());
  const dir = join(file, "..");
  if (!existsSync(file)) {
    // Generate a fresh Ed25519 key pair.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "der" },
      publicKeyEncoding:  { type: "spki",  format: "der" },
    });
    const doc = {
      v: 1,
      privateKey: privateKey.toString("base64"),
      publicKey:  publicKey.toString("base64"),
      created: new Date().toISOString(),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    try { chmodSync(file, 0o600); } catch {}
    return _fromDoc(doc);
  }

  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new Error(`fleet.key at ${file} is not valid JSON: ${e.message}`);
  }
  if (!doc || doc.v !== 1 || typeof doc.privateKey !== "string" || typeof doc.publicKey !== "string") {
    throw new Error(`fleet.key at ${file} is malformed — delete it to regenerate`);
  }
  return _fromDoc(doc);
}

function _fromDoc(doc) {
  const privateKeyObj = createPrivateKey({
    key: Buffer.from(doc.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyObj = createPublicKey({
    key: Buffer.from(doc.publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  // Export the raw 32-byte public key (no envelope) for compact wire format.
  const publicKeyBytes = publicKeyObj.export({ type: "spki", format: "der" }).slice(-32);
  return { privateKeyObj, publicKeyBytes };
}

/**
 * Sign a Buffer with the fleet private key.
 * Returns a 64-byte Buffer (Ed25519 signature).
 */
export function signPayload(privateKeyObj, payload) {
  return edSign(null, payload, privateKeyObj);
}

/**
 * Verify a signature against a raw 32-byte public key Buffer.
 * Returns true if valid, false otherwise. Never throws.
 */
export function verifyPayload(publicKeyBytes, payload, signature) {
  if (!publicKeyBytes || publicKeyBytes.length !== 32) return false;
  if (!signature || signature.length !== 64) return false;
  try {
    // Reconstruct the SPKI envelope the crypto module needs.
    // Ed25519 SPKI header is always the same 12 bytes.
    const SPKI_PREFIX = Buffer.from(
      "302a300506032b6570032100", "hex"
    );
    const spki = Buffer.concat([SPKI_PREFIX, publicKeyBytes]);
    const keyObj = createPublicKey({ key: spki, format: "der", type: "spki" });
    return edVerify(null, payload, keyObj, signature);
  } catch {
    return false;
  }
}

/**
 * Read ONLY the public key bytes from the fleet.key file without loading
 * the private key. Safe to call in contexts that only need verification.
 * Returns 32-byte Buffer or null if no key file exists.
 */
export function readPublicKeyBytes(home) {
  const file = keyPath(home ?? homedir());
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, "utf-8"));
    if (!doc || doc.v !== 1 || typeof doc.publicKey !== "string") return null;
    const publicKeyObj = createPublicKey({
      key: Buffer.from(doc.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return publicKeyObj.export({ type: "spki", format: "der" }).slice(-32);
  } catch {
    return null;
  }
}

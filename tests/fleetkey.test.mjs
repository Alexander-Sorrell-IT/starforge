// Tests for src/fleetkey.mjs — Ed25519 fleet identity for LAN peer auth.
//
// No network. No child_process. All crypto runs locally.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadOrCreateFleetKey,
  signPayload,
  verifyPayload,
  readPublicKeyBytes,
  keyPath,
} from "../src/fleetkey.mjs";

import {
  encodePacket,
  decodePacket,
  signPacket,
  verifyPacket,
  buildAnnouncePayload,
} from "../src/beacon.mjs";

// ---- loadOrCreateFleetKey --------------------------------------------------

test("loadOrCreateFleetKey generates a key on first call", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const key = loadOrCreateFleetKey(home);
  assert.ok(key.privateKeyObj, "has privateKeyObj");
  assert.ok(key.publicKeyBytes instanceof Buffer, "publicKeyBytes is a Buffer");
  assert.strictEqual(key.publicKeyBytes.length, 32, "public key is 32 bytes");
});

test("loadOrCreateFleetKey writes fleet.key to disk", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  loadOrCreateFleetKey(home);
  const file = keyPath(home);
  const stat = statSync(file);
  assert.ok(stat.isFile(), "fleet.key exists");
  const doc = JSON.parse(readFileSync(file, "utf-8"));
  assert.strictEqual(doc.v, 1, "version field is 1");
  assert.ok(typeof doc.privateKey === "string", "privateKey present");
  assert.ok(typeof doc.publicKey === "string", "publicKey present");
});

test("loadOrCreateFleetKey returns the same key on repeated calls", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const k1 = loadOrCreateFleetKey(home);
  const k2 = loadOrCreateFleetKey(home);
  assert.ok(k1.publicKeyBytes.equals(k2.publicKeyBytes), "public key stable across loads");
});

test("fleet.key file has restricted permissions (0o600)", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  loadOrCreateFleetKey(home);
  const stat = statSync(keyPath(home));
  // On Linux, mode & 0o777 should be 0o600
  const mode = stat.mode & 0o777;
  assert.strictEqual(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
});

// ---- signPayload / verifyPayload -------------------------------------------

test("signPayload produces a 64-byte signature", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const { privateKeyObj } = loadOrCreateFleetKey(home);
  const payload = Buffer.from("hello fleet");
  const sig = signPayload(privateKeyObj, payload);
  assert.ok(sig instanceof Buffer, "sig is a Buffer");
  assert.strictEqual(sig.length, 64, "Ed25519 signature is always 64 bytes");
});

test("verifyPayload accepts a valid signature", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const { privateKeyObj, publicKeyBytes } = loadOrCreateFleetKey(home);
  const payload = Buffer.from("verify me");
  const sig = signPayload(privateKeyObj, payload);
  assert.ok(verifyPayload(publicKeyBytes, payload, sig), "valid sig accepted");
});

test("verifyPayload rejects a tampered payload", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const { privateKeyObj, publicKeyBytes } = loadOrCreateFleetKey(home);
  const payload = Buffer.from("original");
  const sig = signPayload(privateKeyObj, payload);
  const tampered = Buffer.from("modified");
  assert.ok(!verifyPayload(publicKeyBytes, tampered, sig), "tampered payload rejected");
});

test("verifyPayload rejects a wrong public key", () => {
  const homeA = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const homeB = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const keyA = loadOrCreateFleetKey(homeA);
  const keyB = loadOrCreateFleetKey(homeB);
  const payload = Buffer.from("fleet A data");
  const sig = signPayload(keyA.privateKeyObj, payload);
  // fleet B's public key should not verify fleet A's signature
  assert.ok(!verifyPayload(keyB.publicKeyBytes, payload, sig), "wrong pubkey rejected");
});

test("verifyPayload returns false for a bad signature buffer", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const { publicKeyBytes } = loadOrCreateFleetKey(home);
  const payload = Buffer.from("data");
  const fakeSig = Buffer.alloc(64, 0xff);
  assert.ok(!verifyPayload(publicKeyBytes, payload, fakeSig), "garbage sig rejected");
});

test("verifyPayload returns false for wrong-length pubkey", () => {
  const payload = Buffer.from("data");
  const sig = Buffer.alloc(64);
  assert.ok(!verifyPayload(Buffer.alloc(16), payload, sig), "short pubkey returns false");
  assert.ok(!verifyPayload(null, payload, sig), "null pubkey returns false");
});

// ---- readPublicKeyBytes ----------------------------------------------------

test("readPublicKeyBytes returns null when no fleet.key exists", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  assert.strictEqual(readPublicKeyBytes(home), null);
});

test("readPublicKeyBytes returns same bytes as loadOrCreateFleetKey", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const { publicKeyBytes } = loadOrCreateFleetKey(home);
  const read = readPublicKeyBytes(home);
  assert.ok(read instanceof Buffer, "returns a Buffer");
  assert.ok(read.equals(publicKeyBytes), "matches key generated by loadOrCreate");
});

// ---- signPacket / verifyPacket integration ---------------------------------

test("signPacket + verifyPacket roundtrips a valid announce packet", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const fleetKey = loadOrCreateFleetKey(home);
  const pubB64 = fleetKey.publicKeyBytes.toString("base64");
  const payload = buildAnnouncePayload({ machine: "test-box", pub: pubB64 });
  const unsigned = encodePacket("announce", payload);
  assert.ok(unsigned, "encodePacket produced a buffer");
  const signed = signPacket(unsigned, fleetKey.privateKeyObj);
  assert.ok(signed, "signPacket produced a buffer");
  const verified = verifyPacket(signed, fleetKey.publicKeyBytes);
  assert.ok(verified, "verifyPacket accepted the signed packet");
  assert.strictEqual(verified.machine, "test-box", "machine field intact");
});

test("verifyPacket rejects an unsigned announce packet when key is present", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const fleetKey = loadOrCreateFleetKey(home);
  const unsigned = encodePacket("announce", { machine: "rogue", sentAt: new Date().toISOString() });
  const result = verifyPacket(unsigned, fleetKey.publicKeyBytes);
  assert.strictEqual(result, null, "unsigned packet from unknown machine rejected");
});

test("verifyPacket rejects a packet signed by a different fleet key", () => {
  const homeA = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const homeB = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const keyA = loadOrCreateFleetKey(homeA);
  const keyB = loadOrCreateFleetKey(homeB);
  const pubAB64 = keyA.publicKeyBytes.toString("base64");
  const payload = buildAnnouncePayload({ machine: "fleet-a-box", pub: pubAB64 });
  const unsigned = encodePacket("announce", payload);
  const signed = signPacket(unsigned, keyA.privateKeyObj);
  // Fleet B tries to verify fleet A's packet — should fail (different pubkey)
  assert.strictEqual(verifyPacket(signed, keyB.publicKeyBytes), null, "wrong fleet rejected");
});

test("verifyPacket passes non-announce packets through without signature check", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const fleetKey = loadOrCreateFleetKey(home);
  // coordinator packets are never signed
  const coordBuf = encodePacket("coordinator", { machine: "coord-box" });
  const pkt = verifyPacket(coordBuf, fleetKey.publicKeyBytes);
  assert.ok(pkt, "coordinator packet passes through");
  assert.strictEqual(pkt.kind, "coordinator");
});

test("verifyPacket returns null for a tampered signed packet", () => {
  const home = mkdtempSync(join(tmpdir(), "sr-fk-"));
  const fleetKey = loadOrCreateFleetKey(home);
  const pubB64 = fleetKey.publicKeyBytes.toString("base64");
  const payload = buildAnnouncePayload({ machine: "honest-box", pub: pubB64 });
  const unsigned = encodePacket("announce", payload);
  const signed = signPacket(unsigned, fleetKey.privateKeyObj);
  // Tamper: flip a byte in the middle of the packet
  const tampered = Buffer.from(signed);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  assert.strictEqual(verifyPacket(tampered, fleetKey.publicKeyBytes), null, "tampered packet rejected");
});

// ---- buildAnnouncePayload with pub -----------------------------------------

test("buildAnnouncePayload includes pub field when provided", () => {
  const pubB64 = Buffer.alloc(32, 7).toString("base64");
  const p = buildAnnouncePayload({ machine: "m", pub: pubB64 });
  assert.strictEqual(p.pub, pubB64, "pub field present");
});

test("buildAnnouncePayload omits pub field when not provided", () => {
  const p = buildAnnouncePayload({ machine: "m" });
  assert.ok(!("pub" in p), "pub absent when not supplied");
});

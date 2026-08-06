// Tamper-EVIDENT automatic run log for starforge (audit schema v1).
//
// Every run writes ~/.starforge/audit/run-<ISO ':'->'-'>.json recording what
// was read, what was written (path + sha256), the sha256 of every source file
// that ran, any tripwire hits (see tripwire.mjs), and the sha256 of the
// PREVIOUS run log — a hash chain, so editing any past log breaks the chain at
// a detectable point.
//
// HONESTY: the chain is tamper-EVIDENT bookkeeping, not cryptographic
// attestation. Its exact limits are in AUDIT_LIMITS, which the verify command
// prints. Never claim more than those lines allow.
import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { maskPath, maskText } from "./redact.mjs";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
export const AUDIT_DIR = join(homedir(), ".starforge", "audit");

// Plain-English limits of this log. The verify command prints these.
export const AUDIT_LIMITS = Object.freeze([
  "The hash chain detects edits to any individual past log, but NOT a wholesale rewrite: anyone (including this tool) with write access to the audit dir can regenerate every log with a self-consistent chain. This is tamper-evident bookkeeping, not cryptographic attestation.",
  "The newest log has no successor yet, so edits to it are undetectable until the next run chains onto it.",
  "Logs are written by the same process they describe: a compromised or malicious process can log whatever it likes. Trust in the log is trust in the source you ran (compare source_hash against the tree you audited).",
  "Deleting the entire audit dir erases history without breaking anything; only a gap in your own expectations reveals it.",
]);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function detectConfinement() {
  // confine.mjs (the OS-level wrapper) sets this env var when it launches us
  // under sandbox-exec / a network namespace. From inside the process we can
  // only repeat the claim — real proof is the user-run check command.
  const claimed = process.env.STARFORGE_CONFINEMENT;
  if (claimed === "sandbox-exec" || claimed === "netns") {
    return {
      mode: claimed,
      verified: false,
      detail:
        "claimed via STARFORGE_CONFINEMENT by the wrapper; not verifiable from inside the process — run the user-side confinement check for proof",
    };
  }
  return {
    mode: "none",
    verified: false,
    detail:
      "no OS confinement claimed; only the in-process tripwire is active, and a tripwire is not a security boundary",
  };
}

// Begin a run log. opts.dir / opts.srcDir exist so tests never touch the real
// ~/.starforge. Internal fields (_dir, recorder) are non-enumerable so they
// stay out of the serialized JSON.
export function startAudit(argv, { dir = AUDIT_DIR, srcDir = SRC_DIR } = {}) {
  const source_files = {};
  try {
    for (const f of readdirSync(srcDir).filter((n) => n.endsWith(".mjs")).sort()) {
      try {
        source_files[f] = sha256(readFileSync(join(srcDir, f)));
      } catch {
        source_files[f] = "unreadable";
      }
    }
  } catch {}
  const source_hash = sha256(
    Object.entries(source_files)
      .map(([n, h]) => `${n}:${h}`)
      .sort()
      .join("\n")
  );

  const audit = {
    schema: 1,
    started_at: new Date().toISOString(),
    finished_at: null,
    argv: (argv ?? []).map((a) => maskText(String(a))),
    node_version: process.version,
    confinement: detectConfinement(),
    source_files,
    source_hash,
    reads: {},
    writes: [],
    tripwire_hits: [],
    prev_log_sha256: null,
  };
  Object.defineProperty(audit, "_dir", { value: dir, enumerable: false });
  Object.defineProperty(audit, "recorder", {
    // Hand this to armTripwire() so every hit lands in the run log.
    value: (hit) => {
      try {
        audit.tripwire_hits.push(hit);
      } catch {}
    },
    enumerable: false,
  });
  return audit;
}

export function auditRead(audit, source) {
  if (!audit?.reads) return;
  audit.reads[source] = (audit.reads[source] ?? 0) + 1;
}

// Record a write (masked path + content hash + size) and hand the content
// back, so call sites stay one-liners: writeFileSync(p, auditWrite(audit, p, s)).
export function auditWrite(audit, path, content) {
  try {
    if (audit?.writes) {
      const buf = typeof content === "string" ? Buffer.from(content) : content;
      audit.writes.push({
        path: maskPath(path),
        sha256: sha256(buf),
        bytes: buf.length,
      });
    }
  } catch {}
  return content;
}

function logFiles(dir) {
  return readdirSync(dir)
    .filter((f) => /^run-.*\.json$/.test(f))
    .sort();
}

// Close and persist the run log. Chains prev_log_sha256 to the latest existing
// log. NEVER throws — the audit trail must not be able to break a run.
// Returns the written path, or null when the dir is unwritable.
export function finishAudit(audit) {
  try {
    audit.finished_at = new Date().toISOString();
    const dir = audit._dir ?? AUDIT_DIR;
    mkdirSync(dir, { recursive: true });

    const files = logFiles(dir);
    const prev = files[files.length - 1];
    audit.prev_log_sha256 = prev ? sha256(readFileSync(join(dir, prev))) : null;

    // Filename from finished_at; on a (sub-ms) collision bump the timestamp by
    // 1ms so lexicographic filename order stays chain order.
    let ts = Date.parse(audit.finished_at);
    let name;
    do {
      name = `run-${new Date(ts).toISOString().replace(/:/g, "-")}.json`;
      ts += 1;
    } while (existsSync(join(dir, name)));

    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(audit, null, 2));
    return p;
  } catch {
    return null;
  }
}

// Walk every log in chain order and re-hash each predecessor against the
// prev_log_sha256 its successor recorded. A break's `index` points at the log
// that no longer matches (the likely-edited one); `detected_at` is the
// successor whose pointer exposed it. Remember AUDIT_LIMITS: an attacker who
// rewrites EVERY log passes this check.
export function verifyAuditChain(dir = AUDIT_DIR) {
  let files = [];
  try {
    files = logFiles(dir);
  } catch {}
  const breaks = [];
  let total_tripwire_hits = 0;
  let prevRaw = null;

  files.forEach((f, i) => {
    let raw = null;
    let log = null;
    try {
      raw = readFileSync(join(dir, f));
      log = JSON.parse(raw);
    } catch {}
    if (!log) {
      breaks.push({
        index: i,
        file: maskPath(join(dir, f)),
        reason: "log is unreadable or not valid JSON",
      });
      prevRaw = raw;
      return;
    }
    if (Array.isArray(log.tripwire_hits)) total_tripwire_hits += log.tripwire_hits.length;
    if (i > 0 && prevRaw !== null && log.prev_log_sha256 !== sha256(prevRaw)) {
      breaks.push({
        index: i - 1,
        detected_at: i,
        file: maskPath(join(dir, files[i - 1])),
        reason: `log ${i - 1} no longer hashes to the prev_log_sha256 recorded by log ${i} (edited, replaced, or reordered)`,
      });
    }
    prevRaw = raw;
  });

  return { ok: breaks.length === 0, breaks, runs: files.length, total_tripwire_hits };
}

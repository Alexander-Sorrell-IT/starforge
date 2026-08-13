// Tamper-EVIDENT automatic run log for starreckon (audit schema v2).
//
// Every run writes ~/.starreckon/audit/run-<ISO ':'->'-'>.json recording what
// was read, what was written (path + sha256), the sha256 of every source file
// that ran, any tripwire hits (see tripwire.mjs), a monotonic run_index, and
// the sha256 of the PREVIOUS run log — a hash chain, so editing a past log
// breaks the chain at a detectable point.
//
// Two things schema v2 adds, both aimed at the same hole: the chain alone can
// only protect a log that a LATER log still vouches for, so any SUFFIX of the
// history could be rewritten or deleted with a self-consistent result.
//   1. run_index — a monotonic counter mirrored in audit-counter.json, which
//      lives OUTSIDE the audit dir. Deleting the oldest logs, the newest logs,
//      or the whole dir now leaves a numeric gap.
//   2. durability — the log is written the moment a tripwire fires and again
//      from the CLI's exit hook, so the one event this log exists to record
//      can no longer erase itself by aborting the run.
// Neither is a security control. Anyone who can write the audit dir can also
// rewrite the counter file. This raises the cost of hiding a run; it does not
// prevent it.
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
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { maskPath, maskText } from "./redact.mjs";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
export const AUDIT_DIR = join(homedir(), ".starreckon", "audit");

// The run counter deliberately lives one level ABOVE the audit dir, so that
// deleting the audit dir does not delete the evidence of how many runs it held.
export const counterFileFor = (dir = AUDIT_DIR) =>
  join(dirname(dir), "audit-counter.json");

// Exactly which writes this log can see. Stored inside every log so the
// artifact states its own coverage instead of relying on the docs being read.
const WRITES_SCOPE =
  "Lists only writes routed through auditWrite: the report files (--json / --card / --page), the monthly snapshots under ~/.starreckon/snapshots, and the per-month star SVGs under ~/.starreckon/stars. Writes into a --join-fleet directory are made by fleet.mjs and are NOT listed here.";

// Plain-English limits of this log. The verify command prints these.
export const AUDIT_LIMITS = Object.freeze([
  "The chain only protects a log that a LATER log still vouches for. Any SUFFIX of the history — the newest log, the newest ten, or all of them — can be rewritten or deleted with a self-consistent result. Hash-chain detection covers edits, deletions and reorderings in the middle of a history whose tail is intact.",
  "Two gap checks raise the cost of that, and neither is a boundary: the first log on disk must be a genesis log (prev_log_sha256: null), and every log carries a monotonic run_index whose highest value is mirrored in audit-counter.json, OUTSIDE the audit dir — so deleting the oldest, the newest, or all logs leaves a numeric gap. An attacker with write access can edit the counter file too.",
  "Logs are written by the same process they describe: a compromised or malicious process can log whatever it likes. Trust in the log is trust in the source you ran (compare source_hash against the tree you audited).",
  "A run that dies can still lose its log. The log is flushed the moment a tripwire fires and again from the CLI's exit hook, which covers a thrown tripwire, an early exit and an uncaught error — but SIGKILL, a power cut or a full disk leave nothing. Absence of a log is not evidence of absence of a hit.",
  "The log lists only writes routed through auditWrite: report files, monthly snapshots and the per-month star SVGs. Writes into a --join-fleet directory you named are not listed (see writes_scope in each log).",
  "Concurrent starreckon runs share one audit dir. Interleaved writes — and a log rewritten in place after an early tripwire flush — can produce a chain break or a duplicate run_index that is a race, not tampering.",
  "The genesis, run_index-gap and completeness checks apply to SCHEMA-2 logs only. Pre-v2 (schema-1) logs carry no run_index and no complete flag, so a schema-1 stretch of history is covered by the hash chain alone — the counts printed above say how many logs of each schema are on disk, so you can see how much of the history the gap checks actually cover.",
  "`--reset-audit` deletes the logs and records the deletion (count, index range, sha256 of each removed log) in the genesis of the new chain, and never rolls the run counter back. That record is a CLAIM made by the process that wrote it: it proves the logs were removed and lets a copy you kept be matched by hash — it is not proof of what was in them.",
]);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// A launcher that starts starreckon under an OS sandbox sets
// STARRECKON_CONFINEMENT: runConfined() in confine.mjs passes it to the confined
// child, bin/starreckon-proof.sh sets it on its sandboxed runs, and the command
// printed by `starreckon prove` carries it so a hand-run proof is labelled too.
// It is a CLAIM, never evidence: any process can set the variable, and a run
// genuinely confined by a launcher that did NOT set it records "none". That is
// why verified is false in every branch — the only proof is the user-run
// positive control (PROVE-IT.md §1).
function detectConfinement() {
  const claimed = process.env.STARRECKON_CONFINEMENT;
  if (claimed === "sandbox-exec" || claimed === "netns") {
    return {
      mode: claimed,
      verified: false,
      detail:
        "claimed via STARRECKON_CONFINEMENT by whatever launched this process; any process can set that variable, so this is an unverified self-report — the proof is the user-run positive control (see `starreckon prove`)",
    };
  }
  if (claimed) {
    return {
      mode: "none",
      verified: false,
      detail:
        "STARRECKON_CONFINEMENT was set to an unrecognized value and ignored (only sandbox-exec and netns are recognized) — treat this run as unconfined unless you ran the positive control yourself",
    };
  }
  return {
    mode: "none",
    verified: false,
    detail:
      "no OS confinement claimed: either this run was unconfined, or it was confined by a launcher that did not set STARRECKON_CONFINEMENT. Only the in-process tripwire was active, and a tripwire is not a security boundary",
  };
}

// Begin a run log. opts.dir / opts.srcDir / opts.counterFile exist so tests
// never touch the real ~/.starreckon. Internal fields (_dir, recorder, …) are
// non-enumerable so they stay out of the serialized JSON.
export function startAudit(
  argv,
  { dir = AUDIT_DIR, srcDir = SRC_DIR, counterFile = null } = {}
) {
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
    schema: 2,
    started_at: new Date().toISOString(),
    finished_at: null,
    // false until the run reaches its normal end. A log left at false is a run
    // that aborted (or a process that was killed after the log was flushed).
    complete: false,
    abort_reason: null,
    run_index: null,
    argv: (argv ?? []).map((a) => maskText(String(a))),
    node_version: process.version,
    confinement: detectConfinement(),
    source_files,
    source_hash,
    reads: {},
    writes: [],
    writes_scope: WRITES_SCOPE,
    tripwire_hits: [],
    prev_log_sha256: null,
  };
  const hidden = (key, value) =>
    Object.defineProperty(audit, key, { value, enumerable: false, writable: true });
  hidden("_dir", dir);
  hidden("_counterFile", counterFile ?? counterFileFor(dir));
  hidden("_path", null); // set on first write; later writes rewrite this file
  hidden("_exitHook", null);
  Object.defineProperty(audit, "recorder", {
    // Hand this to armTripwire() so every hit lands in the run log — and lands
    // on DISK immediately, because trip() throws and the run may never reach
    // finishAudit(). An alarm that erases its own evidence is worse than none.
    value: (hit) => {
      try {
        audit.tripwire_hits.push(hit);
      } catch {}
      try {
        persist(audit, {
          complete: false,
          abort_reason:
            "flushed at a tripwire hit; the run had not finished when this log was written",
        });
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

function readRunCounter(file) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return Number.isInteger(j?.last_run_index) && j.last_run_index >= 0
      ? j.last_run_index
      : null;
  } catch {
    return null;
  }
}

function writeRunCounter(file, index) {
  try {
    const cur = readRunCounter(file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          schema: 1,
          last_run_index: cur === null ? index : Math.max(cur, index),
          updated_at: new Date().toISOString(),
          note: "Highest run_index starreckon has written. Kept outside the audit dir so deleting that dir leaves a visible gap. Anyone who can write the audit dir can rewrite this file too.",
        },
        null,
        2
      )
    );
  } catch {}
}

// Highest evidence wins: the newest log's index, the counter file, or (for a
// dir of pre-v2 logs that carry no index) the number of logs already there.
function nextRunIndex(dir, counterFile, files) {
  const candidates = [];
  const newest = files[files.length - 1];
  if (newest) {
    try {
      const prev = JSON.parse(readFileSync(join(dir, newest), "utf8"));
      if (Number.isInteger(prev?.run_index)) candidates.push(prev.run_index + 1);
    } catch {}
  }
  const counter = readRunCounter(counterFile);
  if (counter !== null) candidates.push(counter + 1);
  if (candidates.length === 0) candidates.push(files.length);
  return Math.max(...candidates);
}

// Write (or re-write) the run log. NEVER throws — the audit trail must not be
// able to break a run. Returns the written path, or null when the dir is
// unwritable. The first call picks the filename, the chain pointer and the
// run_index; later calls update the SAME file in place, so one run is always
// exactly one log.
function persist(audit, { complete, abort_reason }) {
  try {
    audit.finished_at = new Date().toISOString();
    audit.complete = complete;
    audit.abort_reason = abort_reason ? maskText(String(abort_reason)).slice(0, 300) : null;
    const dir = audit._dir ?? AUDIT_DIR;
    mkdirSync(dir, { recursive: true });

    if (audit._path) {
      writeFileSync(audit._path, JSON.stringify(audit, null, 2));
      return audit._path;
    }

    const files = logFiles(dir);
    const prev = files[files.length - 1];
    audit.prev_log_sha256 = prev ? sha256(readFileSync(join(dir, prev))) : null;
    audit.run_index = nextRunIndex(dir, audit._counterFile, files);

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
    audit._path = p;
    writeRunCounter(audit._counterFile, audit.run_index);
    return p;
  } catch {
    return null;
  }
}

// Close and persist the run log for a run that finished normally.
export function finishAudit(audit) {
  if (!audit) return null;
  return persist(audit, { complete: true, abort_reason: null });
}

// Persist the log of a run that did NOT finish: a thrown tripwire, an uncaught
// error, or an early exit. Called from the CLI's catch handler and exit hook.
export function abortAudit(audit, reason) {
  if (!audit) return null;
  return persist(audit, {
    complete: false,
    abort_reason: reason ?? "run aborted for an unrecorded reason",
  });
}

// Last-resort durability: on process exit, write the log if the run never
// reached finishAudit(). Synchronous by necessity — 'exit' allows nothing else.
// Cannot help against SIGKILL (see AUDIT_LIMITS).
export function armAuditExitHook(audit) {
  if (!audit || audit._exitHook) return audit?._exitHook ?? null;
  const onExit = () => {
    if (audit.complete) return;
    abortAudit(
      audit,
      audit.abort_reason ??
        "the process exited before this run reached finishAudit(). The CAUSE IS NOT RECORDED " +
          "HERE: it may be a crash, a tripwire throw, a signal, or an early exit whose own " +
          "code path did not close the log. Do not read this as 'the tool crashed'"
    );
  };
  audit._exitHook = onExit;
  try {
    process.on("exit", onExit);
  } catch {}
  return onExit;
}

// ---- the documented way out of a poisoned history ---------------------------
// The bind this exists to break, found on the author's own machine: a run log
// written by an OLDER version can fail TODAY's output leak scan (it recorded an
// argv that the current masking rules would have masked). Deleting that log
// clears the leak — and breaks the chain, because its successor still points at
// it. Without a supported remedy the user chooses between a standing leak
// finding and a standing tamper-evidence break, and either way `verify` is red
// forever.
//
// resetAudit() clears the audit dir and starts a new chain whose FIRST entry is
// a record of the clearing. It is deliberately not a way to do this quietly:
//   · every removed log's filename, sha256 and run_index go into the record, so
//     "which logs were removed" stays answerable and any copy you kept can be
//     matched by hash;
//   · the run counter, which lives OUTSIDE the audit dir, is never rolled back,
//     so run_index keeps counting and the record shows how much history existed;
//   · the record is the genesis of the new chain, so verify prints it under the
//     audit check on every future run. Deleting it to hide the reset trips the
//     genesis / head-truncation check.
// What it cannot do (see AUDIT_LIMITS): it does not recover the deleted logs
// and it cannot prove WHY they were removed. Anyone who can write these files
// can also forge this record — it raises the cost of a quiet deletion from
// "rm -rf" to "forge a self-consistent record"; it is not a boundary.
// One phrasing for "what was removed", used by the CLI when it happens and by
// verify every time afterwards, so the two can never drift apart.
export function describeRemovedLogs(rec) {
  if (!rec || typeof rec !== "object") return "an unrecorded number of run log(s)";
  const total = Number.isInteger(rec.removed_logs) ? rec.removed_logs : 0;
  const first = rec.removed_index_first;
  const last = rec.removed_index_last;
  const indexed = Number.isInteger(rec.removed_with_run_index)
    ? rec.removed_with_run_index
    : Number.isInteger(first) && Number.isInteger(last)
      ? total
      : 0;
  if (total === 0) return "no run logs — the audit dir was already empty";
  if (!Number.isInteger(first) || !Number.isInteger(last))
    return `${total} run log(s), none of which carried a run_index (pre-v2 logs)`;
  if (indexed >= total) return `${total} run log(s) — run_index ${first}..${last}`;
  return `${total} run log(s) — ${indexed} of them run_index ${first}..${last}, the other ${
    total - indexed
  } carried no run_index (pre-v2 logs)`;
}

export function resetAudit(dir = AUDIT_DIR, { counterFile = null, reason = null } = {}) {
  const counterPath = counterFile ?? counterFileFor(dir);
  let files = [];
  try {
    files = logFiles(dir);
  } catch {}

  const removed = [];
  let firstIndex = null;
  let lastIndex = null;
  for (const f of files) {
    const full = join(dir, f);
    let idx = null;
    let hash = "unreadable";
    try {
      const raw = readFileSync(full);
      hash = sha256(raw);
      const log = JSON.parse(raw);
      if (Number.isInteger(log?.run_index)) idx = log.run_index;
    } catch {}
    if (idx !== null) {
      if (firstIndex === null || idx < firstIndex) firstIndex = idx;
      if (lastIndex === null || idx > lastIndex) lastIndex = idx;
    }
    removed.push({ file: f, sha256: hash, run_index: idx });
  }

  const counterBefore = readRunCounter(counterPath);
  // The new chain continues the numbering it inherited — resetting the count to
  // zero is exactly the erasure this is meant not to be.
  const index = nextRunIndex(dir, counterPath, files);

  mkdirSync(dir, { recursive: true });
  for (const r of removed) {
    try {
      unlinkSync(join(dir, r.file));
    } catch {}
  }

  const at = new Date().toISOString();
  const record = {
    schema: 2,
    kind: "audit-reset",
    started_at: at,
    finished_at: at,
    complete: true,
    abort_reason: null,
    run_index: index,
    argv: [],
    node_version: process.version,
    reads: {},
    writes: [],
    tripwire_hits: [],
    prev_log_sha256: null,
    audit_reset: {
      at,
      reason: reason ? maskText(String(reason)).slice(0, 300) : null,
      removed_logs: removed.length,
      // How many of them the gap checks could see at all: a pre-v2 (schema-1)
      // log carries no run_index, so "run_index 9..10" for a dir of 12 logs
      // describes 2 of them. Say which.
      removed_with_run_index: removed.filter((r) => r.run_index !== null).length,
      removed_index_first: firstIndex,
      removed_index_last: lastIndex,
      counter_last_index_before: counterBefore,
      removed,
    },
    note:
      "This is the genesis of a new audit chain. The logs listed in audit_reset were DELETED by `starreckon --reset-audit`; their sha256 is kept so a copy can be matched, their contents are gone. The run counter was not rolled back.",
  };

  let ts = Date.parse(at);
  let name;
  do {
    name = `run-${new Date(ts).toISOString().replace(/:/g, "-")}.json`;
    ts += 1;
  } while (existsSync(join(dir, name)));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(record, null, 2));
  writeRunCounter(counterPath, index);

  return {
    path,
    // the audit_reset block exactly as it was written, so callers describe what
    // is on disk (describeRemovedLogs) rather than a parallel summary
    record: record.audit_reset,
    removed_logs: removed.length,
    removed,
    removed_index_first: firstIndex,
    removed_index_last: lastIndex,
    run_index: index,
    counter_file: counterPath,
  };
}

// Walk every log in chain order and re-hash each predecessor against the
// prev_log_sha256 its successor recorded. A break's `index` points at the log
// that no longer matches (the likely-edited one); `detected_at` is the
// successor whose pointer exposed it. Three further checks look for the gaps
// the chain alone cannot see: a first log that is not a genesis log, a jump in
// run_index, and a run counter (outside the dir) that expects more logs than
// are present. Remember AUDIT_LIMITS: whoever can write these files can also
// rewrite the counter.
export function verifyAuditChain(dir = AUDIT_DIR, { counterFile = null } = {}) {
  const counterPath = counterFile ?? counterFileFor(dir);
  let files = [];
  try {
    files = logFiles(dir);
  } catch {}
  const breaks = [];
  const notes = [];
  let total_tripwire_hits = 0;
  let incomplete_runs = 0;
  let prevRaw = null;
  let prevLog = null;
  let prevIndexAt = null; // array position of the last log that carried a run_index
  let firstIndex = null;
  let lastIndex = null;
  let headBreak = false;
  // Which logs the gap/genesis/completeness checks can actually see. A history
  // that is mostly schema-1 is covered by the hash chain ALONE, and a PASS that
  // prints limits about run_index over a dir where 10 of 11 logs carry none is
  // describing a check it did not run.
  let current_logs = 0;
  let legacy_logs = 0;
  let resets = 0;

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
      prevLog = null;
      return;
    }
    if (Array.isArray(log.tripwire_hits)) total_tripwire_hits += log.tripwire_hits.length;
    if (log.complete === false) incomplete_runs += 1;
    if (log.schema === 2) current_logs += 1;
    else legacy_logs += 1;
    if (log.audit_reset && typeof log.audit_reset === "object") resets += 1;

    if (i === 0 && log.prev_log_sha256 !== null && log.prev_log_sha256 !== undefined) {
      headBreak = true;
      breaks.push({
        index: 0,
        file: maskPath(join(dir, f)),
        reason:
          "chain does not begin at a genesis log — the oldest log on disk records a prev_log_sha256, i.e. a predecessor that is no longer here (head truncation)",
      });
    }
    if (i > 0 && prevRaw !== null && log.prev_log_sha256 !== sha256(prevRaw)) {
      breaks.push({
        index: i - 1,
        detected_at: i,
        file: maskPath(join(dir, files[i - 1])),
        reason: `log ${i - 1} no longer hashes to the prev_log_sha256 recorded by log ${i} (edited, replaced, or reordered)`,
      });
    }

    // ---- run_index sequence (pre-v2 logs carry none; those pairs are skipped)
    if (Number.isInteger(log.run_index)) {
      if (firstIndex === null) firstIndex = log.run_index;
      lastIndex = log.run_index;
      if (
        prevIndexAt !== null &&
        prevIndexAt === i - 1 &&
        Number.isInteger(prevLog?.run_index) &&
        log.run_index !== prevLog.run_index + 1
      ) {
        const gap = log.run_index - prevLog.run_index - 1;
        breaks.push({
          index: i,
          detected_at: i,
          file: maskPath(join(dir, f)),
          reason:
            gap > 0
              ? `run_index jumps from ${prevLog.run_index} to ${log.run_index} — ${gap} run log(s) missing between them`
              : `run_index goes from ${prevLog.run_index} to ${log.run_index} — not monotonic (rewritten logs, or two runs that raced for the same index)`,
        });
      }
      if (i === 0 && log.run_index > 0 && !headBreak) {
        // …unless this genesis log IS the record of the deletion. `--reset-audit`
        // is the supported way to retire a poisoned history (resetAudit above),
        // and it pays for itself by leaving this record in place of the logs.
        // The record has to ACCOUNT for the missing indices: one that supersedes
        // up to index 4 does not explain a chain starting at index 9.
        const rec = log.audit_reset;
        const wellFormed =
          rec && typeof rec === "object" && Number.isInteger(rec.removed_logs) && rec.removed_logs >= 0;
        const accounts =
          wellFormed &&
          (rec.removed_index_last === null ||
            rec.removed_index_last === undefined ||
            rec.removed_index_last === log.run_index - 1);
        if (accounts) {
          notes.push(
            `the audit history was RESET at ${rec.at ?? "an unrecorded time"}: \`starreckon --reset-audit\` DELETED ${describeRemovedLogs(rec)}, and this genesis log records the sha256 of each one. Reason given: ${rec.reason ? `"${rec.reason}"` : "none"}. The run counter was not rolled back, so numbering continues at ${log.run_index}. The deleted logs are gone; this record is a claim, not a copy of them`
          );
        } else {
          breaks.push({
            index: 0,
            file: maskPath(join(dir, f)),
            reason: wellFormed
              ? `history starts at run_index ${log.run_index} and carries an audit_reset record, but that record only accounts for logs up to index ${rec.removed_index_last} — ${log.run_index - 1 - rec.removed_index_last} run log(s) are missing that the reset does not explain`
              : `history starts at run_index ${log.run_index}, not 0 — ${log.run_index} earlier run log(s) are missing (the audit dir was deleted or replaced while audit-counter.json survived). If you meant to retire them, \`starreckon --reset-audit\` records the deletion here instead of leaving this gap`,
          });
        }
      }
      prevIndexAt = i;
    }

    prevRaw = raw;
    prevLog = log;
  });

  // ---- the counter file, which lives outside this dir --------------------
  const counter = readRunCounter(counterPath);
  if (counter === null) {
    notes.push(
      `no run counter at ${maskPath(counterPath)} — deletion of the newest logs cannot be detected (pre-v2 history, or the file was removed)`
    );
  } else if (lastIndex === null) {
    if (files.length > 0)
      notes.push(
        `run counter says runs were recorded up to index ${counter}, but no log on disk carries a run_index (pre-v2 logs)`
      );
    else
      breaks.push({
        index: null,
        file: maskPath(dir),
        reason: `the run counter at ${maskPath(counterPath)} records ${counter + 1} run(s), but this dir holds no logs at all — the history was deleted`,
      });
  } else if (counter > lastIndex) {
    breaks.push({
      index: files.length - 1,
      file: maskPath(join(dir, files[files.length - 1])),
      reason: `the run counter at ${maskPath(counterPath)} records runs up to index ${counter}, but this — the newest log on disk — is index ${lastIndex}: ${counter - lastIndex} of the newest run log(s) are missing (tail truncation)`,
    });
  } else if (counter < lastIndex) {
    notes.push(
      `run counter (${counter}) is behind the newest log (${lastIndex}) — the counter file was reset, removed, or edited, so it cannot vouch for the tail`
    );
  }

  if (incomplete_runs > 0)
    notes.push(
      `${incomplete_runs} run(s) recorded as INCOMPLETE — the log was written before the run closed it. That is not by itself evidence of a crash (a tripwire throw, a signal, or an early exit look the same from here); read each abort_reason, which says only what is actually known`
    );

  return {
    ok: breaks.length === 0,
    breaks,
    runs: files.length,
    current_logs,
    legacy_logs,
    resets,
    total_tripwire_hits,
    incomplete_runs,
    sequence: {
      first_index: firstIndex,
      last_index: lastIndex,
      counter_last_index: counter,
      counter_file: maskPath(counterPath),
    },
    notes,
  };
}

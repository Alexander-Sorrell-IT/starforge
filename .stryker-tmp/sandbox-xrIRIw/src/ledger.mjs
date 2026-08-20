// @ts-nocheck
// Append-only token ledger for starreckon.
//
// Ported from deadreckon-count/token_ledger.py — same rules, same guarantees:
//
//   - One JSONL file: ~/.starreckon/token_ledger.jsonl
//   - One record per session observed, keyed by (cli, session_id)
//   - Deleting a transcript cannot lower the lifetime total
//     (the old observation stays in the ledger)
//   - Fixing the scanner CAN correct it: a newer scanner_version's number
//     wins over an older scanner's inflated one
//
// THE KEY RULE:
//   For each session: take all ledger rows. Find the newest scanner_version
//   that ever saw this session (by last-seen index in the file). Among all
//   rows from THAT version, take the maximum per field.
//
//   The maximum is conditional on rows SHARING a version tag, and one class of
//   row never does: a scan that could not determine its own version is tagged
//   unhashable-<uuid>, fresh per appended row, so it is ranked and superseded
//   rather than maxed. lifetime()'s docstring below states the whole condition
//   and why the trade is the right one — this summary is the short form.
//
// This means:
//   - A re-scan after more turns → higher number wins (correct)
//   - Transcript deleted, re-scan → old observation preserved (correct)
//   - Scanner fix deployed → new correct number wins over old inflated one
//     (correct — a rollback to an old scanner also works because "newest"
//      means last-seen, not largest hash)
//
// CLIs with a native lifetime counter on disk (Claude's stats-cache.json):
//   marked ★ — the ledger supplements the vendor counter
// All other CLIs:
//   marked † — ledger starts from when the daemon first ran; no vendor counter

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEDGER_FILE = "token_ledger.jsonl";
export const FIELDS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
];

// CLIs with a persistent vendor-side lifetime counter on disk.
// For these the ledger supplements; for all others it is the only record.
const NATIVE_LIFETIME_CLIS = new Set(["claude"]);

export function cliMarker(cli) {
  return NATIVE_LIFETIME_CLIS.has(cli) ? "★" : "†";
}

// ---- file location ---------------------------------------------------------

export function ledgerPath(home) {
  return join(home ?? homedir(), ".starreckon", LEDGER_FILE);
}

// ---- read ------------------------------------------------------------------

/**
 * Every row in the ledger, oldest first.
 * A single malformed line costs one row — the rest are unaffected.
 */
export function rows(home) {
  const p = ledgerPath(home);
  if (!existsSync(p)) return [];
  // errors="replace" equivalent: read as utf-8, skip lines that won't parse.
  // A torn write at shutdown must not make the file permanently unreadable.
  let text;
  try { text = readFileSync(p, "utf-8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * The lifetime total and per-CLI breakdown.
 *
 * For each (cli, session_id) pair: find the newest scanner tag that ever
 * observed it (by last-seen position in the file, not by hash magnitude).
 * Among all rows carrying THAT SAME TAG, take the field-wise maximum so a
 * partial write cannot shrink a session.
 *
 * THE MAXIMUM IS CONDITIONAL ON THE TAG. This used to be stated flat — "among
 * all rows from that version, take the field-wise maximum" — and that claimed
 * more than the code delivers. Max happens only between rows whose tag is
 * EQUAL (`rank === cur.rank` below), and there are three kinds of tag:
 *
 *   a real scanner version  every row that scan wrote carries it, so those rows
 *                           share a bucket and merge: max. The "more turns"
 *                           case, and the only one the old wording described.
 *   "pre-versioning"        the sentinel for rows written before the `scanner`
 *                           field existed. Legacy rows all share it, so they
 *                           merge with each other too.
 *   "unhashable-<uuid>"     what record() writes when it could not determine a
 *                           scanner version. FRESH PER APPENDED ROW, therefore
 *                           shared with nothing — not even the next unhashable
 *                           row. Those rows are ranked, never merged: the newest
 *                           observation SUPERSEDES rather than maximises.
 *
 * The third case is deliberate. "I could not determine the version" is not a
 * version, and maxing two of them together is how a corrected over-count
 * becomes permanent: the correction is smaller by construction, so it loses the
 * max in every future run and no later fix can dislodge it. Measured one level
 * up, on this machine, when snapshots did exactly that — a stored 2026-07
 * record of 16,636 sessions against a true 132 (see snapshots.mjs:106-131).
 * The trade: unhashable rows get no floor, so a re-scan that saw less does
 * lower them. That is the cheaper wrong, because it is recoverable by scanning
 * again and a frozen number is not.
 *
 * Both halves are pinned by tests/ledger.test.mjs — "max WITHIN one known
 * scanner tag, supersede ACROSS unknown ones".
 *
 * Note on scope: the per-FIELD maxima computed below feed nothing that leaves
 * this function. The returned shape carries `total` (itself maxed) and the
 * per-CLI sums; the four FIELDS values are dropped by the destructure at the
 * `byCli` loop. "Field-wise" describes the merge, not the output.
 *
 * Returns:
 *   { total, sessions, by_cli, by_cli_marked, earliest, latest }
 */
export function lifetime(home) {
  const allRows = rows(home);

  // Build version rank: last-seen index for each scanner version.
  // "last seen" = what a rollback intends: the scanner you most recently used.
  const order = new Map(); // version -> last index in allRows
  allRows.forEach((r, i) => {
    const v = r.scanner ?? "pre-versioning";
    order.set(v, i);
  });

  // best: (cli, sid) -> { rank, fields... }
  const best = new Map();

  for (const r of allRows) {
    const cli = r.cli;
    const sid = r.session_id;
    if (!cli || !sid) continue;
    const key = `${cli}\0${sid}`;
    const rank = order.get(r.scanner ?? "pre-versioning") ?? -1;
    const cur = best.get(key);

    if (!cur || rank > cur.rank) {
      best.set(key, { rank, cli, total: intOr0(r.total), ...fieldPick(r) });
    } else if (rank === cur.rank) {
      // Same scanner saw this session twice — take field-wise max.
      cur.total = Math.max(cur.total, intOr0(r.total));
      for (const f of FIELDS) {
        cur[f] = Math.max(intOr0(cur[f]), intOr0(r[f]));
      }
    }
  }

  const byCli = {};
  let total = 0;
  let earliest = null, latest = null;

  for (const { cli, total: t, ...rest } of best.values()) {
    byCli[cli] = (byCli[cli] ?? 0) + t;
    total += t;
  }

  // Earliest/latest from raw rows (not filtered by version — covers full span)
  for (const r of allRows) {
    const ts = r.start;
    if (typeof ts === "string" && ts) {
      if (!earliest || ts < earliest) earliest = ts;
      if (!latest || ts > latest) latest = ts;
    }
  }

  const byCliMarked = {};
  for (const [cli, t] of Object.entries(byCli)) {
    byCliMarked[cli] = { total: t, marker: cliMarker(cli) };
  }

  return {
    total,
    sessions: best.size,
    by_cli: byCli,
    by_cli_marked: byCliMarked,
    earliest,
    latest,
  };
}

// ---- write -----------------------------------------------------------------

/**
 * Record sessions from a scan into the ledger.
 *
 * `sessions` is an array of session objects as returned by the scanners:
 *   { cli, session_id, tokens: {input_tokens,...}, total, start, model,
 *     scanner_version? }
 *
 * `scannerVersion` is the version string to tag all new rows with.
 *
 * Only appends rows that are new or have a higher total than the last
 * observation from the same scanner version. Does NOT re-write existing rows.
 *
 * `scannerVersion == null` takes the other path documented below: the test is
 * DIFFERENT total, not higher, because those rows are never merged and a lower
 * number from a later scan is a restatement that has to be able to land.
 *
 * Returns { appended, unchanged } counts.
 */
export function record(sessions, scannerVersion, home) {
  if (!sessions || sessions.length === 0) return { appended: 0, unchanged: 0 };

  // R1 vs R2 split:
  //   R1 (dedup): record() must not append a row whose (cli, sid, total) is
  //       already represented in the ledger — or the file grows without bound.
  //   R2 (no-merge): lifetime() must not Math.max two rows from scans that
  //       could not hash themselves — a value meaning "I do not know" must not
  //       behave like a value.
  //
  // For a real scanner version both requirements are satisfied by the stable
  // version string: same-version / same-or-higher total → skip; rows with the
  // same version share a rank bucket and field-wise-max correctly.
  //
  // For a null scanner version the requirements pull in opposite directions:
  //   - R1 needs a stable key to find existing rows and skip duplicates.
  //   - R2 needs each written row to have a UNIQUE scanner tag so lifetime()
  //     never puts two null-scanner rows in the same rank bucket.
  //
  // Solution: null-scanner rows are written with a fresh unhashable-<uuid>
  // tag each time they are appended (satisfying R2).  Dedup (R1) is handled
  // separately: skip if any existing unhashable-* row for this (cli, sid)
  // already carries exactly this total.  An EQUAL total means "same data,
  // same machine, nothing changed" — do not re-append.  A DIFFERENT total
  // means a legitimately new observation (more turns, or a different machine's
  // count) — append with a fresh UUID so it lands in its own rank bucket.
  const isNullScanner = scannerVersion == null;
  const existing = rows(home);

  // For known-version rows: (cli, sid, version) -> max total seen.
  // We skip a session only when the same scanner already has an equal-or-higher
  // total; a different scanner's row does NOT prevent recording.
  const alreadyByVer = new Map();
  for (const r of existing) {
    if (!r.cli || !r.session_id) continue;
    const v = r.scanner ?? "pre-versioning";
    const key = `${r.cli}\0${r.session_id}\0${v}`;
    const prev = alreadyByVer.get(key) ?? -1;
    alreadyByVer.set(key, Math.max(prev, intOr0(r.total)));
  }

  // For null-scanner rows: (cli, sid) -> Set of totals already written as
  // unhashable-*.  Skip only when this exact total is already present —
  // a different total is a new observation and must be written.
  const unhashableTotals = new Map();
  if (isNullScanner) {
    for (const r of existing) {
      if (!r.cli || !r.session_id) continue;
      if (typeof r.scanner !== "string" || !r.scanner.startsWith("unhashable-")) continue;
      const k = `${r.cli}\0${r.session_id}`;
      if (!unhashableTotals.has(k)) unhashableTotals.set(k, new Set());
      unhashableTotals.get(k).add(intOr0(r.total));
    }
  }

  const p = ledgerPath(home);
  mkdirSync(join(p, ".."), { recursive: true });

  let appended = 0, unchanged = 0;
  const lines = [];

  for (const s of sessions) {
    const cli = s.cli;
    const sid = s.session_id;
    if (!cli || !sid) continue;

    const tk = s.tokens ?? {};
    const total = intOr0(s.total) || FIELDS.reduce((a, f) => a + intOr0(tk[f]), 0);
    if (total === 0) continue; // nothing to record

    let ver;
    if (isNullScanner) {
      const seenTotals = unhashableTotals.get(`${cli}\0${sid}`) ?? new Set();
      if (seenTotals.has(total)) {
        unchanged += 1;
        continue;
      }
      // Fresh unique tag: each appended unhashable row gets its own rank
      // bucket in lifetime(), so two different null-scanner observations
      // can never Math.max into each other.
      ver = `unhashable-${randomUUID()}`;
      // Track within this call to prevent double-appending for the same
      // (cli, sid, total) pair appearing twice in the sessions array.
      if (!unhashableTotals.has(`${cli}\0${sid}`)) unhashableTotals.set(`${cli}\0${sid}`, new Set());
      unhashableTotals.get(`${cli}\0${sid}`).add(total);
    } else {
      ver = scannerVersion;
      const verKey = `${cli}\0${sid}\0${ver}`;
      const prevTotal = alreadyByVer.get(verKey) ?? -1;
      if (prevTotal >= total) {
        unchanged += 1;
        continue;
      }
      alreadyByVer.set(verKey, total); // prevent double-appending in same call
    }

    const row = {
      cli,
      session_id: sid,
      scanner: ver,
      total,
      input_tokens: intOr0(tk.input_tokens),
      cache_creation_input_tokens: intOr0(tk.cache_creation_input_tokens),
      cache_read_input_tokens: intOr0(tk.cache_read_input_tokens),
      output_tokens: intOr0(tk.output_tokens),
      start: (s.start ?? "").slice(0, 10) || null,
      model: s.model ?? "unknown",
      recorded_at: new Date().toISOString(),
    };
    lines.push(JSON.stringify(row));
    appended += 1;
  }

  if (lines.length > 0) {
    appendFileSync(p, lines.join("\n") + "\n", "utf-8");
  }

  return { appended, unchanged };
}

/**
 * Compare what the ledger remembers vs what is on disk now.
 * Returns { ledger_total, disk_total, ledger_only, both, sessions_on_disk }.
 */
export function compare(sessions, home) {
  const lt = lifetime(home);
  const diskById = new Map();
  for (const s of sessions ?? []) {
    if (s.cli && s.session_id) {
      diskById.set(`${s.cli}\0${s.session_id}`, s.total ?? 0);
    }
  }

  // Sessions the ledger knows about but are no longer on disk
  const allRows_ = rows(home);
  const seenKeys = new Set();
  for (const r of allRows_) {
    if (r.cli && r.session_id) seenKeys.add(`${r.cli}\0${r.session_id}`);
  }
  const ledgerOnly = [...seenKeys].filter(k => !diskById.has(k)).length;

  return {
    ledger_total: lt.total,
    disk_total: [...diskById.values()].reduce((a, b) => a + b, 0),
    ledger_only: ledgerOnly,
    both: [...seenKeys].filter(k => diskById.has(k)).length,
    sessions_on_disk: diskById.size,
  };
}

// ---- helpers ---------------------------------------------------------------

function intOr0(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : 0;
}

function fieldPick(r) {
  const o = {};
  for (const f of FIELDS) o[f] = intOr0(r[f]);
  return o;
}

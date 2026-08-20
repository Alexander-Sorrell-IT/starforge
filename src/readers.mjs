// Readers starreckon did not have. Ported from deadreckon's Python against a
// written spec, not from memory — every field name below was read out of the
// source it came from, because a guessed key returns 0 and 0 is exactly what a
// store that is genuinely empty returns.
//
// WHAT THIS FILE IS ALLOWED TO TOUCH
//
// node:fs, node:path, node:crypto — and node:sqlite, lazily, for `bob` alone.
// No network, no child_process, so no new entry in verify.mjs's STATIC_ALLOWLIST
// is required. Everything here answers a question about files that are already
// on this disk.
//
// EVERY READER RETURNS A STATE, NOT JUST A NUMBER
//
//   absent      the store is not on this machine. Nothing was found because
//               there is nothing to find.
//   empty       the store is there and holds no countable session.
//   counted     the store is there and yielded sessions.
//   unreadable  the store is there and could not be read — a locked directory,
//               a corrupt database, a Node without the builtin `bob` needs.
//
// `absent`, `empty` and `unreadable` all total zero. That is the entire reason
// the state exists: this project has shipped the confusion between them seven
// times in four disguises, and a caller that sees only the number cannot tell
// "you have never used this tool" from "I could not open your data".

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { freemem } from "node:os";
import { constants as BUFFER_CONSTANTS } from "node:buffer";
import { vscodeRoots } from "./scanners.mjs";
import { probe, stateOf, loadSources } from "./sources.mjs";

// Node cannot hold a string longer than this, so readFileSync throws rather
// than returning a short read. Checked before opening anything, because the
// Copilot Chat store runs to gigabytes.
const MAX_STRING = BUFFER_CONSTANTS.MAX_STRING_LENGTH;

const BUCKETS = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });

/**
 * Where this source lives on this machine, from the spec — never from a path
 * typed into this file.
 *
 * Every reader below used to build its own `join(home, ".thing", "sessions")`,
 * so "absent" meant "not at the one place I happen to know" and four files
 * could disagree about where the same tool lives. The paths are declared in
 * spec/sources.json now and `probe()` walks them; a reader's job is to count
 * what it is handed.
 *
 * The probe is passed in by scanPortedReaders so one scan does not walk the
 * same tree twice; the fallback is for direct callers and tests.
 */
function look(name, home, pr) {
  if (pr) return pr;
  const spec = loadSources();
  const src = spec.sources.find((x) => x.name === name);
  if (!src) throw new Error(`readers: ${name} is not declared in spec/sources.json`);
  return probe(src, home, spec);
}

function result(state, sessions, extra = {}) {
  const tokens = BUCKETS();
  for (const s of sessions) {
    tokens.input += s.tokens.input;
    tokens.cacheWrite += s.tokens.cacheWrite;
    tokens.cacheRead += s.tokens.cacheRead;
    tokens.output += s.tokens.output;
  }
  const total = tokens.input + tokens.cacheWrite + tokens.cacheRead + tokens.output;
  return { state, sessions, tokens, total, ...extra };
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function ls(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return null;              // null means "could not read", NOT "empty"
  }
}

// ── claude orphans ────────────────────────────────────────────────────────────

/**
 * Sessions whose TRANSCRIPT IS GONE and whose counters survived.
 *
 * Claude Code's `cleanupPeriodDays` sweep deletes `projects/**´/*.jsonl` and
 * does not clear `projects.<cwd>.lastTotal*Tokens`, so for a deleted session
 * those counters are the only record that it ever happened. On the machine this
 * was ported from they account for 4,172,332,033 tokens across 78 sessions that
 * nothing else in either program can see.
 *
 * THREE TRAPS, ALL OF WHICH PRODUCE A CONFIDENT WRONG NUMBER:
 *
 * 1. `lastModelUsage` RESTATES `lastTotal*` per model. Verified on a real
 *    entry: 600278 + 61304 + 19044 = 680626 = lastTotalInputTokens exactly.
 *    Reading both is a clean 2x. Only the lastTotal* fields are summed here.
 *
 * 2. The same session appears in MANY config files — the live one, its
 *    backups, and the archive's copies. Summing per file gave 759,975,256,912
 *    against a true 4,172,332,033: 182 times over. Records are merged per
 *    session id by per-field MAXIMUM, never added.
 *
 * 3. The same FILE is reachable by more than one glob, and through hard links
 *    in the archive. Files are deduplicated by (device, inode) before anything
 *    is read.
 *
 * `known` is the set of session ids the ordinary Claude reader already
 * emitted. It is a REQUIRED argument rather than an optional one: defaulting
 * it to empty would mean a caller who forgets it silently counts every live
 * session twice, and that is the kind of default that reads as working.
 */
export function readClaudeOrphans(home, known, pr) {
  if (!(known instanceof Set)) {
    throw new TypeError(
      "readClaudeOrphans(home, known): `known` must be the Set of session ids "
      + "the Claude transcript reader already emitted. Without it every live "
      + "session is counted a second time.");
  }
  pr = look("claude-orphans", home, pr);

  // THE SPEC DECLARES WHERE THE CONFIG FILES ARE. THEIR BACKUPS ARE A
  // CONVENTION OF THE FILE, NOT A PLACE.
  //
  // `.claude.json.bak*` beside it, timestamped copies under `backups/`, and the
  // archive's mirrors are all "this file, earlier" — expanded here rather than
  // declared, because declaring them would mean putting `*` patterns in the
  // spec and a glob is read differently by Python's glob and Node's fs.
  //
  // They are not optional: a counter that has since been reset survives only in
  // a backup, and dropping them would lose exactly the sessions this reader is
  // for. Files are deduplicated by (device, inode) below, so a backup that is a
  // hard link to something already read costs nothing.
  const cands = [];
  const push = (x) => { if (existsSync(x)) cands.push(x); };

  // `.claude.json.` — the dot matters. The prefix here was `.claude.json.bak`,
  // and `.backup` is b-a-c-k-u-p: `~/.claude.json.backup` did not match it and
  // was silently dropped. There are three backup conventions in play —
  // `.claude.json.backup` beside the file, `.claude.json.bak-<reason>` inside a
  // profile, and timestamped copies under `backups/` — and matching the common
  // prefix covers all three without guessing at the next one.
  const sib = (dir) => {
    for (const e of ls(dir) ?? [])
      if (e.startsWith(".claude.json.")) push(join(dir, e));
  };
  for (const f of pr.found) {
    let st;
    try { st = statSync(f); } catch { continue; }
    // A declared `backups` directory contributes its contents; a declared
    // config file contributes itself and its siblings.
    if (st.isDirectory()) { sib(f); continue; }
    push(f);
    sib(dirname(f));
  }

  const archive = join(home, ".ai-logs-archive", "claude");
  for (const prof of ls(archive) ?? []) {
    const backups = join(archive, prof, "backups");
    for (const f of ls(backups) ?? []) {
      if (f.startsWith(".claude.json.backup.")) push(join(backups, f));
    }
  }

  if (cands.length === 0) return result(pr.state, [], { files: 0, probe: pr });

  const seenInode = new Set();
  const best = new Map();          // sessionId -> per-field maximum
  let read = 0, projects = 0;

  for (const p of cands) {
    let st;
    try { st = statSync(p); } catch { continue; }
    const key = st.ino !== 0 ? `${st.dev}:${st.ino}` : p;
    if (seenInode.has(key)) continue;
    seenInode.add(key);

    const d = readJson(p);
    if (!d || typeof d.projects !== "object" || d.projects === null) continue;
    read += 1;

    for (const [cwd, pr] of Object.entries(d.projects)) {
      if (!pr || typeof pr !== "object") continue;
      projects += 1;
      const sid = pr.lastSessionId;
      if (typeof sid !== "string" || !sid) continue;

      // THE FOUR FIELDS, AND ONLY THESE FOUR.
      const t = {
        input: Number(pr.lastTotalInputTokens) || 0,
        cacheWrite: Number(pr.lastTotalCacheCreationInputTokens) || 0,
        cacheRead: Number(pr.lastTotalCacheReadInputTokens) || 0,
        output: Number(pr.lastTotalOutputTokens) || 0,
      };
      const held = best.get(sid);
      if (!held) {
        best.set(sid, { sid, project: cwd, tokens: t });
      } else {
        // PER-FIELD MAXIMUM, NOT A SUM. Two copies of one session are one
        // session; the fuller copy wins each field.
        for (const k of ["input", "cacheWrite", "cacheRead", "output"]) {
          if (t[k] > held.tokens[k]) held.tokens[k] = t[k];
        }
      }
    }
  }

  const sessions = [];
  for (const [sid, rec] of best) {
    if (known.has(sid)) continue;                       // its transcript is alive
    const sum = rec.tokens.input + rec.tokens.cacheWrite
              + rec.tokens.cacheRead + rec.tokens.output;
    if (sum === 0) continue;                            // a counter that never ran
    // NO TIMESTAMPS, EVER. A vanished session has no transcript, so it has no
    // turn to take a date from. That is a property of the thing, not a gap in
    // the reader, and inventing one would move real tokens into a month that
    // did not earn them.
    sessions.push({ id: sid, cli: "claude", project: rec.project,
                    tokens: rec.tokens, start: null, end: null, transcript: false });
  }

  return result(stateOf(pr, sessions.length), sessions,
                { files: read, projects, probe: pr });
}

// ── clawspring ────────────────────────────────────────────────────────────────

/**
 * Clawspring's per-session rollups: ~/.clawspring/sessions/daily/**´/session_*.json
 *
 * The format has NO cache counters at all, so cacheWrite and cacheRead stay 0 —
 * they are absent from the data, not zero in it. Only two keys are summed, and
 * a file lacking `total_input_tokens` is not a session rollup and is skipped.
 */
/**
 * A token count, or null if the value is not one.
 *
 * `Number(v) || 0` was the coercion here and it is the loosest in the program:
 * it rejects NaN and nothing else. jazzer.js reached it in seconds with
 * `total_input_tokens: 1e400` — a number JSON accepts and JS parses as
 * Infinity, which `Number()` passes straight through, which then leaves the
 * machine and becomes `null` in the written file. Absent looking exactly like
 * zero, one more time.
 *
 * The same value CRASHES deadreckon (`int(inf)` raises OverflowError), and the
 * two programs disagreed on six of nine malformed shapes. This is the rule
 * both now apply: finite, non-negative, integral, and not a boolean. Numeric
 * strings are accepted because both programs already accepted them and real
 * rollups have used them.
 *
 * SAFE integer, not merely integer. Above 2**53 JavaScript cannot hold the
 * value exactly and Python can, so the two programs are guaranteed to disagree
 * on anything larger — 1e308 reads as 1e+308 here and as a 309-digit integer
 * there. A number no one can agree on is not a count.
 */
export function tokenCount(v) {
  if (typeof v === "boolean" || v === null || v === undefined) return null;
  const n = typeof v === "string" ? (v.trim() === "" ? NaN : Number(v)) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

export function readClawspring(home, pr) {
  pr = look("clawspring", home, pr);
  if (!pr.present) return result(pr.state, [], { probe: pr });

  const files = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const e of ls(dir) ?? []) {
      const p = join(dir, e);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) walk(p, depth + 1);
      else if (e.startsWith("session_") && e.endsWith(".json")) files.push(p);
    }
  };
  for (const base of pr.found) walk(base, 0);

  const bySession = new Map();
  const unreadable = [];
  for (const f of files) {
    const d = readJson(f);
    // The presence of `total_input_tokens` is what makes this a rollup. A file
    // without it is some other JSON that happens to sit here.
    if (!d || typeof d !== "object" || d.total_input_tokens === undefined) continue;
    const sid = d.session_id || f.split("/").pop().replace(/\.json$/, "");
    // A rollup whose counters are not counts is NAMED, not guessed at. The
    // alternative is a file that reads as a real session holding 0, or
    // Infinity, or a negative number, and none of those announce themselves.
    const inTok = tokenCount(d.total_input_tokens);
    const outTok = d.total_output_tokens === undefined ? 0 : tokenCount(d.total_output_tokens);
    if (inTok === null || outTok === null) { unreadable.push(f); continue; }
    const t = { input: inTok, cacheWrite: 0, cacheRead: 0, output: outTok };
    const held = bySession.get(sid);
    if (!held) bySession.set(sid, { id: sid, cli: "clawspring", tokens: t });
    else {
      // Merged by per-field MAXIMUM across copies of one session, matching
      // deadreckon's multi_base(key="session_id") rule.
      for (const k of ["input", "cacheWrite", "cacheRead", "output"]) {
        if (t[k] > held.tokens[k]) held.tokens[k] = t[k];
      }
    }
  }

  // A ROLLUP THAT RECORDS NO TOKENS IS NOT A SESSION. deadreckon does not
  // emit one, and the first draft of this port did: totals agreed to the token
  // (258,502,806) while the session COUNT read 20 against its 18. Two files —
  // session_110942_a1d15969 and session_114329_223b858c — carry
  // total_input_tokens 0 and total_output_tokens 0. A divergence that moves
  // the count and not the sum is exactly the kind that survives every
  // sum-based check, which is why it is filtered here and asserted in the
  // conformance fixture rather than left to be noticed.
  const sessions = [...bySession.values()].filter(
    (s) => s.tokens.input + s.tokens.cacheWrite + s.tokens.cacheRead + s.tokens.output > 0);
  return result(stateOf(pr, sessions.length), sessions,
                { files: files.length, emptyRollups: bySession.size - sessions.length,
                  unreadable, probe: pr });
}

// ── lmstudio ──────────────────────────────────────────────────────────────────

/**
 * Local models: ~/.lmstudio/conversations/*.json
 *
 * `billed: false` marks a LOCAL model — the work ran on this machine and never
 * went through a provider account. It is a fact about where the computation
 * happened, not a claim about money: nothing in this program attaches a price
 * to a token, and tests/no-cost.test.mjs enforces that no source file here
 * ever does. The field exists for parity with deadreckon's record shape, which
 * draws the same local-versus-provider line.
 *
 * Per-step counters live at `genInfo.stats.promptTokensCount` and
 * `predictedTokensCount`.
 */
export function readLmstudio(home, pr) {
  pr = look("lmstudio", home, pr);
  if (!pr.present) return result(pr.state, [], { probe: pr });

  const sessions = [];
  let files = 0;
  const entries = pr.found.flatMap((b) => (ls(b) ?? []).map((e) => [b, e]));
  for (const [base, e] of entries) {
    if (!e.endsWith(".json")) continue;
    files += 1;
    const d = readJson(join(base, e));
    if (!d) continue;
    // THE EXACT PATH, NOT A SEARCH. The first draft walked the whole document
    // looking for any `genInfo.stats`, which is MORE permissive than
    // deadreckon's messages[].versions[].steps[].genInfo.stats. The two agreed
    // on the real store — every live file has the proper nesting — so the
    // divergence was invisible there and would have appeared only on a
    // malformed or future-shaped file, as one program counting what the other
    // ignored. Matching the path exactly is the whole job of a port.
    const t = BUCKETS();
    for (const m of d.messages ?? []) {
      for (const v of m?.versions ?? []) {
        for (const st of v?.steps ?? []) {
          const stats = st?.genInfo?.stats;
          if (!stats || typeof stats !== "object") continue;
          t.input += Number(stats.promptTokensCount) || 0;
          t.output += Number(stats.predictedTokensCount) || 0;
        }
      }
    }
    if (t.input + t.output === 0) continue;
    sessions.push({ id: e.replace(/\.json$/, ""), cli: "lmstudio",
                    tokens: t, billed: false });
  }

  return result(stateOf(pr, sessions.length), sessions, { files, probe: pr });
}

// ── bob ───────────────────────────────────────────────────────────────────────

/**
 * The only store here backed by SQLite: ~/.bob/db/bob.db, `tasks` table.
 *
 * WHY THE IMPORT IS LAZY AND GUARDED. `node:sqlite` is a builtin, so reading
 * this costs no dependency and starreckon's zero-dependency rule survives — but
 * it landed in Node 22.5 and is still flagged experimental. On an older Node
 * the import throws, and the honest answer there is `unreadable`: the store
 * exists, it holds tokens, and this build cannot open it. Reporting 0 would
 * make an unsupported runtime look like an unused tool.
 *
 * THE FIELD NAMES FLIP, AND GETTING IT WRONG IS INVISIBLE. `costs` is bob's own
 * column name and it holds TOKEN COUNTS, not money — this reader never sees a
 * price and never computes one. Its keys are camelCase; the destination buckets
 * are named for Anthropic's usage fields. Swapping cacheWrite and cacheRead preserves the grand total exactly,
 * so every sum check still passes while two buckets are wrong — the same shape
 * as the five sum-preserving corruptions that passed 22 checks in this
 * project's history.
 *
 *     costs.input      -> input        costs.cacheWrite -> cacheWrite
 *     costs.cacheRead  -> cacheRead    costs.output     -> output
 */
export async function readBob(home, pr) {
  pr = look("bob", home, pr);
  if (!pr.present) return result(pr.state, [], { probe: pr });
  // EVERY FOUND STORE, NOT found[0]. This was the only reader in the file that
  // took the first location and discarded the rest — the other five all iterate
  // pr.found. A machine with two bob databases had the second one silently
  // dropped, and on the machine this was written on that was 11 tasks and
  // 116,711,574 tokens, half of bob's real total.
  const dbs = pr.found.map((d) => join(d, "bob.db")).filter((f) => existsSync(f));
  if (!dbs.length) return result("empty", [], { probe: pr, why: "the store is there and holds no bob.db" });

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return result("unreadable", [], {
      why: "node:sqlite is unavailable in this Node (it arrived in 22.5). The "
         + "store is present and holds sessions this build cannot read — this "
         + "is not zero usage.",
    });
  }

  // Merged by per-field MAXIMUM on the task id, which is deadreckon's
  // multi_base rule. A database that is a COPY contributes nothing; one holding
  // its own rows contributes them; and a copy whose tail was truncated loses
  // field by field to the fuller one rather than winning by being read first.
  const byId = new Map();
  let rowCount = 0;
  const unreadable = [];

  for (const db of dbs) {
    let handle;
    try {
      handle = new DatabaseSync(db, { readOnly: true });
    } catch (e) {
      // ONE BAD DATABASE MUST NOT LOSE THE OTHERS. Returning "unreadable" here
      // threw away every database already read.
      unreadable.push(`${db}: ${e.message}`);
      continue;
    }
    try {
      const rows = handle.prepare(
        "SELECT id, costs FROM tasks WHERE costs IS NOT NULL").all();
      rowCount += rows.length;
      for (const r of rows) {
      let c;
      try { c = JSON.parse(r.costs); } catch { continue; }
      // BOB'S `input` IS THE WHOLE PROMPT. cacheRead and cacheWrite are PARTS
      // of it, not additions. Summing all four counted every cached token
      // twice — bob read 38,783,298 where it holds 19,441,479 — and BOTH
      // programs did it, so the conformance fixture's expected value was
      // derived from the same misreading. That is the one failure a shared
      // oracle cannot catch, which is why the evidence is written down:
      //
      //   111 of 111 per-turn `_meta.spend` rows satisfy
      //   contextTokens == input + output. A context window is prompt plus
      //   completion, so `input` is the prompt entire.
      //   One turn: input 16,447 against cacheRead 12,137 + cacheWrite 4,309
      //   = 16,446. One uncached token in the whole prompt.
      //
      // The buckets follow Anthropic's convention — input is the UNCACHED part
      // — so bob's gross figure has its cache subtracted to fit. Floored at 0:
      // a negative would mean the format moved, and going quietly negative is
      // how a reader lies about that.
      const cacheRead = Number(c?.cacheRead) || 0;
      const cacheWrite = Number(c?.cacheWrite) || 0;
      const grossInput = Number(c?.input) || 0;
      const t = {
        input: Math.max(0, grossInput - cacheRead - cacheWrite),
        cacheWrite,
        cacheRead,
        output: Number(c?.output) || 0,
      };
      if (t.input + t.cacheWrite + t.cacheRead + t.output === 0) continue;
      const id = String(r.id);
      const held = byId.get(id);
      if (!held) byId.set(id, { id, cli: "bob", tokens: t });
      else for (const k of ["input", "cacheWrite", "cacheRead", "output"])
        if (t[k] > held.tokens[k]) held.tokens[k] = t[k];
      }
    } catch (e) {
      unreadable.push(`${db}: ${e.message}`);
    } finally {
      try { handle.close(); } catch { /* best-effort */ }
    }
  }

  const sessions = [...byId.values()];
  // Every database failed: that is unreadable, not empty. One of several
  // failing is a partial read, and the caller is told which.
  if (unreadable.length === dbs.length)
    return result("unreadable", [], { probe: pr, why: unreadable.join("; ") });
  return result(stateOf(pr, sessions.length), sessions,
                { rows: rowCount, databases: dbs.length, unreadable, probe: pr });
}

// ── copilot chat ──────────────────────────────────────────────────────────────

/**
 * GitHub Copilot **Chat** inside VS Code — a different product from the
 * `~/.copilot` CLI that the ordinary copilot reader handles.
 *
 * IT SUMS EXACTLY ONE NUMBER, AND THAT IS THE HEADLINE, NOT A FOOTNOTE.
 * `requests[].result.metadata.toolCallRounds[].thinking.tokens` — reasoning
 * tokens — into output. There is no prompt counter, no input counter and no
 * cache counter anywhere in this store, so what comes back is a LOWER BOUND ON
 * WHAT IS COUNTABLE. Anything that displays it should say so; it is not a
 * measure of the work and it is certainly not a measure of money.
 *
 * Deduped on `thinking.id`, because a round can be re-emitted. On the store
 * this was ported against: 7,210 thinking blocks carry a `tokens` key, 3,523
 * of them are 0 while still carrying an encrypted blob, 3,687 are positive, and
 * there are exactly 3,687 distinct ids — none reused. A block with no id is
 * counted every time it appears, matching deadreckon, and no such block exists
 * today.
 *
 * THE WALK MUST NOT READ THE STORE. It is 2.29 GB. Only
 * `<workspace>/chatSessions/*.json` and the flat `emptyWindowChatSessions` are
 * opened; nothing else under workspaceStorage is touched.
 */
export function readCopilotChat(home, pr) {
  pr = look("copilot-chat", home, pr);
  if (!pr.present) return result(pr.state, [], { probe: pr });

  const files = [];
  const unreadable = [];
  for (const base of pr.found) {
    if (base.endsWith("emptyWindowChatSessions")) {
      for (const n of (ls(base) ?? []).sort())
        if (n.endsWith(".json")) files.push(join(base, n));
      continue;
    }
    for (const ws of (ls(base) ?? []).sort()) {
      const cs = join(base, ws, "chatSessions");
      let isDir = false;
      try { isDir = statSync(cs).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      for (const n of (ls(cs) ?? []).sort())
        if (n.endsWith(".json")) files.push(join(cs, n));
    }
  }

  const seenThinking = new Set();
  // Per-session accumulator: keyed on session_id (or filename fallback), keeping
  // the running max output across every file that carries the same session.
  // deadreckon deduplicates copilot-chat on session_id across every workspace and
  // base; starreckon was pushing one session object per FILE, so one session
  // opened in two VS Code workspaces counted twice. Zero impact today (all 75
  // real files on this machine have 75 distinct session IDs) but structurally
  // wrong and will break on any multi-workspace user.
  const perSession = new Map(); // session_id -> accumulated session object
  for (const f of files) {
    // SIZE IS CHECKED BEFORE READING. The largest real file in this store is
    // 483,631,203 bytes; Node cannot hold a string past MAX_STRING_LENGTH and
    // readFileSync would throw. A file skipped for size is NAMED, never
    // silently dropped — a store this big losing a file quietly is how a
    // reader reports a fraction of the truth and looks fine doing it.
    let bytes = 0;
    try { bytes = statSync(f).size; } catch { continue; }
    if (bytes > MAX_STRING) {
      unreadable.push({ path: f, bytes, why: "larger than this Node build can hold as a string" });
      continue;
    }
    if (bytes * 5 > freemem()) {
      unreadable.push({ path: f, bytes, why: "not enough free memory to parse it safely" });
      continue;
    }
    const d = readJson(f);
    if (!d || typeof d !== "object") {
      // One real file in this store (54,231,040 bytes) is truncated on disk.
      // deadreckon swallows it; it is recorded here so the gap has a name.
      unreadable.push({ path: f, bytes, why: "not valid JSON — truncated on disk" });
      continue;
    }

    let out = 0, turns = 0;
    for (const req of Array.isArray(d.requests) ? d.requests : []) {
      const rounds = req?.result?.metadata?.toolCallRounds;
      if (!Array.isArray(rounds)) continue;
      turns += 1;
      for (const round of rounds) {
        const th = round?.thinking;
        const n = th?.tokens;
        if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) continue;
        const tid = th?.id;
        if (tid) {
          if (seenThinking.has(tid)) continue;
          seenThinking.add(tid);
        }
        out += n;
      }
    }
    if (out === 0) continue;

    const iso = (ms) =>
      (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);
    const stamps = (Array.isArray(d.requests) ? d.requests : [])
      .map((r) => r?.timestamp)
      .filter((t) => typeof t === "number" && t > 0);
    const sid = (typeof d.sessionId === "string" && d.sessionId)
      ? d.sessionId : basename(f).replace(/\.json$/, "");
    const start = iso(d.creationDate) ?? (stamps.length ? iso(Math.min(...stamps)) : null);
    const end   = iso(d.lastMessageDate) ?? (stamps.length ? iso(Math.max(...stamps)) : null);
    const existing = perSession.get(sid);
    if (!existing) {
      perSession.set(sid, {
        id: sid,
        cli: "copilot-chat",
        account: d.requesterUsername || "copilot-chat",
        project: basename(dirname(dirname(f))),
        // Dates come from the store's own fields, with the per-request stamps as
        // the fallback. `creationDate` was absent from the reader entirely until
        // recently, which put every one of these sessions in the every-CLI total
        // and in NO month at all.
        start,
        end,
        turns,
        // Reasoning tokens are output. The other three buckets are absent from
        // this format, not zero in it.
        tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: out },
      });
    } else {
      // Same session in a second workspace: keep the max output (same rule as
      // the ledger), earliest start, latest end, and sum turns across files.
      existing.tokens.output = Math.max(existing.tokens.output, out);
      if (start && (!existing.start || start < existing.start)) existing.start = start;
      if (end   && (!existing.end   || end   > existing.end))   existing.end   = end;
      existing.turns += turns;
    }
  }
  const sessions = [...perSession.values()];

  // A file this reader could not open is unreadable EVEN IF other files
  // counted: the number is then a floor, and a floor presented as a total is
  // the failure this state exists to prevent.
  const state = unreadable.length ? "unreadable" : stateOf(pr, sessions.length);
  return result(state, sessions, {
    files: files.length,
    unreadable,
    probe: pr,
    lowerBound: true,   // the store has no input counter; see the header
  });
}

// ── history ───────────────────────────────────────────────────────────────────

/**
 * The session ledger from each profile's `history.jsonl`.
 *
 * THIS READER RETURNS NO TOKENS. NOT ZERO TOKENS — NONE. The file records one
 * entry per prompt with a session id, a timestamp and a project, and it holds
 * no usage counters of any kind. It cannot say what a lost session cost and it
 * must never be asked to: a port that gave it token fields would be describing
 * a file that does not have them, and the fields would read as measurements.
 *
 * What it gives instead is proof that a session EXISTED, when, and in which
 * project. Transcripts are deleted on a timer; this is not, and it reaches
 * months further back than they do — on the machine this was ported from, to
 * 2026-01-14 where the oldest surviving transcript is 2026-05-05. That turns
 * "we may have lost some data" into a number of sessions with dates.
 *
 * PROMPT TEXT IS DELIBERATELY NOT READ. `display` and `pastedContents` hold
 * what was typed, and a token counter has no business keeping that. Only the
 * id, the timestamp and the project are taken.
 */
export function readHistory(home, pr) {
  pr = look("history", home, pr);
  if (!pr.present) return { state: pr.state, sessions: [], tokens: null, total: null,
                            prompts: 0, profiles: 0, earliest: null, latest: null, probe: pr };

  const sessions = [];
  let prompts = 0;
  for (const f of pr.found) {
    const profile = basename(dirname(f));
    const per = new Map();
    let text;
    try { text = readFileSync(f, "utf-8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const sid = o?.sessionId;
      if (!sid) continue;
      // Seconds or milliseconds, decided by magnitude — the same 1e11 boundary
      // deadreckon uses, because both forms appear in real files.
      let day = null;
      const ts = o.timestamp;
      if (typeof ts === "number") {
        const d = new Date(ts > 1e11 ? ts : ts * 1000);
        if (!Number.isNaN(d.getTime())) day = d.toISOString().slice(0, 10);
      } else if (typeof ts === "string") {
        day = ts.slice(0, 10) || null;
      }
      let e = per.get(sid);
      if (!e) {
        e = { id: sid, cli: "history", profile, project: o.project ?? null,
              first_day: day, last_day: day, prompts: 0 };
        per.set(sid, e);
      }
      e.prompts += 1;
      prompts += 1;
      if (day) {
        if (!e.first_day || day < e.first_day) e.first_day = day;
        if (!e.last_day || day > e.last_day) e.last_day = day;
      }
    }
    sessions.push(...per.values());
  }

  // NO `tokens` KEY ON THE RESULT. Every other reader here returns bucket
  // totals; this one deliberately does not, so a caller that tries to add it to
  // a total gets an error instead of a silent zero. `sessions` and the date
  // range are the whole output.
  const days = sessions.flatMap((s) => [s.first_day, s.last_day]).filter(Boolean).sort();
  return {
    state: stateOf(pr, sessions.length),
    probe: pr,
    sessions,
    tokens: null,          // not zero — this format has no counters
    total: null,
    prompts,
    profiles: pr.found.length,
    earliest: days[0] ?? null,
    latest: days[days.length - 1] ?? null,
  };
}

// ── cowork ────────────────────────────────────────────────────────────────────

/**
 * Claude's Cowork — the Mac app's local agent mode.
 *
 * IT IS AN ORDINARY MAC APP AND ITS DATA IS STORED LIKE ONE. Application
 * Support, the way Apple tells every app to. What is inside is not a new
 * format at all: it is a tree of ordinary Claude Code profiles, three
 * directories down.
 *
 *   <config-base>/Claude/local-agent-mode-sessions/
 *       <accountUuid>/<orgUuid>/local_<uuid>/.claude/projects/<encoded>/<id>.jsonl
 *
 * So this reader is discovery only — it finds the nested `.claude/projects`
 * trees and hands the paths back. The counting is the Claude parser, unchanged,
 * because the files ARE Claude transcripts.
 *
 * TWO THINGS THAT WOULD OTHERWISE LOSE IT SILENTLY:
 *
 * 1. DEPTH. The nested `.claude` sits seven or eight levels below home. The
 *    ordinary profile walk stops at four, so nothing here is reachable by the
 *    normal discovery — it has to be walked deliberately.
 * 2. THE PROFILE RULE. These are profile-shaped directories with no
 *    `.claude.json` beside them, which is exactly the shape
 *    findConfigDirs refuses — the rule that excludes copied sandbox profiles.
 *    Cowork's are NOT copies, they are the app's own live store, so they are
 *    found here explicitly rather than by that walk. Loosening the general rule
 *    to admit them would have re-admitted the 489,464,459 tokens of sandbox
 *    copies it exists to keep out.
 *
 * Written on Linux, where this store cannot exist, so it reports `absent` here
 * and is unverified against real data. The paths are from the store layout, not
 * guessed; what a Mac run settles is the size of the number, not whether the
 * code is right.
 */
export function coworkProfileDirs(home) {
  const bases = [];
  if (process.platform === "darwin")
    bases.push(join(home, "Library", "Application Support"));
  else if (process.platform === "win32")
    bases.push(process.env.APPDATA || join(home, "AppData", "Roaming"));
  bases.push(join(home, ".config"));      // Linux, and a fallback everywhere

  const roots = bases
    .map((b) => join(b, "Claude", "local-agent-mode-sessions"))
    .filter((p) => existsSync(p));
  if (roots.length === 0) return { state: "absent", dirs: [], roots: [] };

  const dirs = [];
  // account -> org -> local_<uuid> -> .claude. Fixed shape, walked explicitly
  // rather than by a depth limit, so a deeper tree cannot silently swallow it
  // and a shallower one cannot pull in something that is not Cowork's.
  for (const root of roots) {
    for (const account of ls(root) ?? []) {
      for (const org of ls(join(root, account)) ?? []) {
        for (const local of ls(join(root, account, org)) ?? []) {
          const profile = join(root, account, org, local, ".claude");
          if (existsSync(join(profile, "projects"))) dirs.push(profile);
        }
      }
    }
  }
  return {
    state: dirs.length ? "counted" : "empty",
    dirs,
    roots,
  };
}

// @ts-nocheck
// Find AI tool stores by SHAPE, so a tool nobody wrote down is still found.
//
//   node src/discover.mjs             what is here, known and unknown
//   node src/discover.mjs --json
//   node src/discover.mjs --unknown-only
//
// WHY THIS EXISTS
//
// This scanner knows eight hardcoded relative paths. That works exactly as far
// as somebody thought to write one down, and no further. A CLI installed last
// week, or a store that moved on this OS, produces:
//
//     counted tokens   0
//     the star         drawn without it
//     the page         says nothing
//
// which is byte-for-byte what a tool you have never installed produces. Absent
// looks exactly like zero — and here it does so on a picture handed to someone
// else, which is the worst place for it.
//
// BY SHAPE, NOT BY NAME. A name list is the thing that failed; another name
// list is not a fix. `~/.claude*` misses `~/.my-claude`, and every glob only
// finds the spellings its author imagined. So this asks what a store IS: a
// directory holding files whose CONTENT is conversational — rows carrying a
// usage/token accounting, or a database with session-shaped tables.
//
// IT DOES NOT COUNT. Counting needs a reader that understands the format, and
// a number guessed from an unknown one would be worse than no number because
// it would be believed. This answers the question BEFORE that one: is there
// something here nobody is counting?
//
// IT DOES NOT WRITE A READER. A tool found here is a prompt for a human to add
// two things — a path and a reader — and inventing either automatically is how
// you get a reader that agrees with itself.
//
// THE THREE ANSWERS
//
//   KNOWN       a reader already covers this path
//   UNKNOWN     conversational content, covered by nothing
//   AMBIGUOUS   shaped like a store, but the content could not be classified
//
// AMBIGUOUS is not a failure and is not folded into either neighbour. A
// directory that could not be read is a third fact; collapsing it into KNOWN
// hides a gap, collapsing it into UNKNOWN cries wolf until nobody reads this.

import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename, relative, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// Depth 4 from home. Deep enough for ~/.config/<tool>/<profile>/sessions and
// Library/Application Support/<tool>/<x>, shallow enough not to walk a source
// tree. Anything deeper is inside a store, not a store.
export const MAX_DEPTH = 4;

// Trees that cannot contain a tool, or that are OURS. Kept short on purpose so
// it does not quietly become the name list this file exists to replace.
export const SKIP = new Set([
  ".git", "node_modules", "__pycache__", ".cache", ".npm", ".cargo", ".rustup",
  "venv", ".venv", "site-packages", "dist-packages", "Trash", ".Trash",
  "snap", ".steam", "Steam", ".wine", "go", ".gradle", ".m2",
  // ours: an archive is a COPY of stores, and rediscovering it would report
  // every tool twice — once real, once as its own backup
  ".ai-logs-archive", ".starreckon", "deadreckon-count", "deadreckon-record",
]);

// A row carrying one of these is an accounting of model usage. Deliberately
// broad: the point is to notice a format nobody has written a reader for, and
// a narrow list would only recognise the formats already handled.
export const USAGE_KEYS = new Set([
  "usage", "tokens", "token_count", "tokenCount", "input_tokens",
  "output_tokens", "prompt_tokens", "completion_tokens", "total_tokens",
  "totalTokens", "cache_read_input_tokens", "inputTokens", "outputTokens",
]);

// Names that describe CONTENT rather than a vendor. A table or directory
// called one of these holds a conversation whatever wrote it.
export const RECORD_WORDS = new Set([
  "session", "sessions", "conversation", "conversations", "chat", "chats",
  "history", "transcript", "transcripts", "messages", "thread", "threads",
  "rollout", "rollouts", "checkpoints",
]);

// Where a tool's own directory sits. A conversational directory found below
// one of these belongs to the tool owning that directory — it is not a tool in
// its own right.
const TOOL_BASES = ["", ".config", ".local/share", "Library/Application Support",
                    "Library/Containers", "AppData/Roaming", "AppData/Local"];

function safeReaddir(dir) {
  try {
    return { entries: readdirSync(dir, { withFileTypes: true }), err: null };
  } catch (e) {
    return { entries: [], err: e.code || String(e) };
  }
}

// SQLite keeps its schema as plain CREATE TABLE text near the head of the
// file. Reading it that way needs no driver, which matters: this must run on
// stock Node with zero dependencies, and node:sqlite does not exist before
// Node 22. Inconclusive is reported as AMBIGUOUS rather than as "no".
function sqliteTables(path, bytes = 65536) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    const head = buf.slice(0, n).toString("latin1");
    if (!head.startsWith("SQLite format 3")) return null;
    const names = new Set();
    for (const m of head.matchAll(/CREATE TABLE\s+["'`[]?(\w+)/gi)) {
      names.add(m[1].toLowerCase());
    }
    return names;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

/**
 * Does this directory hold model-conversation records? Cheap, bounded.
 *
 * Returns {verdict, why} where verdict is true / false / null, and null means
 * AMBIGUOUS — could not tell. Three values, not two, and the third is the one
 * that keeps this honest: a directory that raised EACCES is not empty.
 */
export function looksConversational(dir, budget = 40) {
  const { entries, err } = safeReaddir(dir);
  if (err) return { verdict: null, why: `directory unreadable (${err})` };
  let seen = 0, unreadable = 0, sawStore = false;

  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (seen >= budget) break;
    if (ent.isDirectory()) continue;
    const p = join(dir, ent.name);
    const lower = ent.name.toLowerCase();

    if (lower.endsWith(".jsonl") || lower.endsWith(".json")) {
      seen += 1;
      let text;
      try {
        // Bounded read: a session file can be hundreds of MB and only the
        // first rows are needed to recognise the shape.
        const fd = openSync(p, "r");
        const buf = Buffer.alloc(262144);
        const n = readSync(fd, buf, 0, buf.length, 0);
        closeSync(fd);
        text = buf.slice(0, n).toString("utf8");
      } catch (e) {
        unreadable += 1;
        continue;
      }
      const lines = text.split("\n").slice(0, 31);
      for (const line of lines) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
        const flat = new Set(Object.keys(rec));
        if (rec.message && typeof rec.message === "object") {
          for (const k of Object.keys(rec.message)) flat.add(k);
        }
        for (const k of flat) {
          if (USAGE_KEYS.has(k)) {
            return { verdict: true, why: `${ent.name}: usage accounting in the rows` };
          }
        }
      }
    } else if (lower.endsWith(".db") || lower.endsWith(".sqlite")
               || lower.endsWith(".sqlite3")) {
      seen += 1;
      sawStore = true;
      const names = sqliteTables(p);
      if (names === null) { unreadable += 1; continue; }
      const hit = [...names].filter((n) => RECORD_WORDS.has(n)).sort();
      if (hit.length) {
        return { verdict: true, why: `${ent.name}: tables ${JSON.stringify(hit)}` };
      }
    }
  }
  if (unreadable) {
    return { verdict: null, why: `${unreadable} file(s) could not be read` };
  }
  if (sawStore) {
    // A database whose schema we read and did not recognise is a real "no";
    // one we could not open landed above. Kept separate so the two never blur.
    return { verdict: false, why: "" };
  }
  return { verdict: false, why: "" };
}

/**
 * The TOOL a conversational directory belongs to, not the directory itself.
 *
 * A store has children; its children are not stores. Without this,
 * `.claude/projects/<one-project>` becomes a finding and there are hundreds of
 * those — the Python original reported 313 "undiscovered tools" of which
 * nearly all were one known store's internals. A hit is attributed upward to
 * the first directory sitting directly under home or under a standard
 * application base, and the report is deduplicated on that.
 */
export function toolRoot(path, home = homedir()) {
  const rel = relative(home, path);
  if (!rel || rel.startsWith("..")) return path;
  const parts = rel.split(sep).filter(Boolean);
  const bases = [...TOOL_BASES].sort((a, b) => b.length - a.length);
  for (const base of bases) {
    const bp = base ? base.split("/") : [];
    if (parts.length > bp.length
        && bp.every((seg, i) => parts[i] === seg)) {
      return join(home, ...parts.slice(0, bp.length + 1));
    }
  }
  return parts.length ? join(home, parts[0]) : path;
}

/**
 * Every candidate store under home, classified. One pass, bounded depth.
 *
 * `knownPaths` is whatever the caller's readers already cover — absolute,
 * resolved. Anything conversational outside that set is UNKNOWN, which is the
 * finding this file exists to produce.
 */
export function walk(home = homedir(), knownPaths = []) {
  const known = new Set(knownPaths.map((p) => p.replace(/\/+$/, "")));
  const found = new Map();          // toolRoot -> record
  const unreadableDirs = [];
  const stack = [[home, 0]];

  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > MAX_DEPTH) continue;
    const { entries, err } = safeReaddir(dir);
    if (err) { unreadableDirs.push(`${dir}: ${err}`); continue; }

    let hasFiles = false;
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (SKIP.has(ent.name)) continue;
        stack.push([join(dir, ent.name), depth + 1]);
      } else {
        hasFiles = true;
      }
    }
    if (!hasFiles || depth === 0) continue;

    const { verdict, why } = looksConversational(dir);
    if (verdict === false) continue;

    const root = toolRoot(dir, home);
    const isKnown = [...known].some(
      (k) => dir === k || dir.startsWith(k + sep) || k.startsWith(root + sep) || k === root);
    const status = isKnown ? "KNOWN" : (verdict === true ? "UNKNOWN" : "AMBIGUOUS");

    const prev = found.get(root);
    // KNOWN beats UNKNOWN beats AMBIGUOUS for the same tool: one directory
    // that could not be read does not make a covered tool a finding.
    const rank = { KNOWN: 3, UNKNOWN: 2, AMBIGUOUS: 1 };
    if (!prev || rank[status] > rank[prev.status]) {
      found.set(root, { tool: basename(root), path: root, status, why, example: dir });
    }
  }

  const out = [...found.values()].sort(
    (a, b) => a.status.localeCompare(b.status) || a.path.localeCompare(b.path));
  return { found: out, unreadableDirs };
}

/** One line per finding, for the CLI and for the page. */
export function summarise(result) {
  const by = { KNOWN: [], UNKNOWN: [], AMBIGUOUS: [] };
  for (const f of result.found) by[f.status].push(f);
  return by;
}

// pathToFileURL, not a template string: a path containing a space arrives here
// percent-encoded in import.meta.url and the naive comparison silently fails,
// so the CLI runs and prints nothing. Which is exactly the failure mode this
// whole file exists to complain about.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = new Set(process.argv.slice(2));
  const result = walk(homedir(), []);
  if (args.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const by = summarise(result);
    for (const status of ["UNKNOWN", "AMBIGUOUS", "KNOWN"]) {
      if (args.has("--unknown-only") && status !== "UNKNOWN") continue;
      const rows = by[status];
      console.log(`\n${status}  ${rows.length}`);
      for (const r of rows) {
        console.log(`  ${r.tool.padEnd(28)} ${r.path}`);
        if (r.why) console.log(`  ${"".padEnd(28)} ${r.why}`);
      }
    }
    if (result.unreadableDirs.length) {
      console.log(`\n${result.unreadableDirs.length} directory(ies) could not be read`);
      console.log("  Not the same as empty. Listed so the gap is visible:");
      for (const d of result.unreadableDirs.slice(0, 5)) console.log(`    ${d}`);
    }
  }
}

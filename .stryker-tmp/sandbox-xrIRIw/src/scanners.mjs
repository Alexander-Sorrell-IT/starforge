// @ts-nocheck
// Multi-CLI session scanners: Gemini CLI, GitHub Copilot CLI, Antigravity,
// Kilo Code, Grok CLI. Port of token-usage/sessions.py (the authoritative
// spec) — the LOGIC is faithful, including every documented counting trap:
// cache-subset splits, rollup-vs-per-turn exclusions, double-emission drops,
// exact-consume protobuf parsing, and copied-profile dedupe by session id.
//
// claude_code / codex / cowork live in scan.mjs and are NOT duplicated here.
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createDecipheriv, createHash } from "node:crypto";
import { homedir } from "node:os";
import { probe, loadSources, stateOf } from "./sources.mjs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { maskPath, maskText, redactSecrets } from "./redact.mjs";

// ---- canonical token record ------------------------------------------------

export const FIELDS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
];
const SENT_FIELDS = FIELDS.slice(0, 3);

// Active time, not elapsed time: a resumed transcript spanning days produced
// a "436-hour day" under wall-clock math. Sum consecutive gaps <= threshold.
const MAX_ACTIVE_GAP_MIN = 15;

// Providers whose models run on this machine: tokens are real, invoice is not.
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "local"]);

export function isBilled(cli, provider) {
  return !(LOCAL_PROVIDERS.has(cli) || LOCAL_PROVIDERS.has(provider));
}

const PROVIDER_PREFIXES = [
  ["claude", "anthropic"], ["deepseek", "deepseek"],
  ["gemini", "google"], ["gemma", "google"],
  ["antigravity", "antigravity"], ["copilot", "copilot"],
  ["gpt", "openai"], ["o1", "openai"], ["o3", "openai"], ["o4", "openai"],
  ["codex", "openai"], ["grok", "xai"], ["llama", "meta"],
  ["mistral", "mistral"], ["mixtral", "mistral"], ["qwen", "qwen"],
  ["kimi", "moonshot"], ["glm", "zhipu"],
];

export function providerOf(model) {
  const m = (model || "").toLowerCase();
  for (const [prefix, vendor] of PROVIDER_PREFIXES) {
    if (m.startsWith(prefix)) return vendor;
  }
  return m === "<synthetic>" || m === "unknown" || m === "" ? "synthetic" : "other";
}

// EVERY FILE THAT DETERMINES A NUMBER, NOT JUST THIS ONE.
//
// This hashed scanners.mjs alone, and the counting is spread wider than that:
// scan.mjs holds parseClaudeFile and parseCodexFile, readers.mjs holds the six
// ported readers, accounts.mjs computes the per-profile totals and decides
// which profiles count at all. On 2026-08-16 the Codex arithmetic in scan.mjs
// was changed — a 1,021,379,811 token correction — and this version did not
// move. A machine scanned before that fix and one scanned after it stamped the
// same string and compared equal, which is the exact skew the hash exists to
// make visible.
//
// WHERE YOU LOOKED DETERMINES A NUMBER TOO.
//
// sources.mjs and spec/sources.json were added on 2026-08-16, when discovery
// moved out of the readers and into the spec ("declare where and what, code
// how"). A reader that counts perfectly still returns the wrong total if it was
// pointed at three stores instead of four, so a change to either of those —
// adding a store, fixing a per-platform base — moves every number without
// touching a line of arithmetic. Before this, two machines that searched
// different paths stamped the same fingerprint and compared equal, which is the
// same class of skew as the Codex correction below, one layer earlier.
//
// Names are hashed alongside contents so that renaming a file, or dropping one
// from this list, changes the answer too.
const COUNTING_SOURCES = [
  "accounts.mjs", "readers.mjs", "scan.mjs", "scanners.mjs", "sources.mjs",
];

// The declared paths are DATA, and data that determines a number is hashed like
// code. Relative to src/, not to cwd: the spec ships inside the package.
const COUNTING_DATA = [
  ["../spec/sources.json", "spec/sources.json"],
];

/**
 * A fingerprint of the code that produced a number, or NULL when it cannot be
 * computed.
 *
 * NULL, NEVER THE STRING "unknown". The previous version returned "unknown"
 * from a bare catch, and "unknown" === "unknown": two machines running
 * different code, both failing to hash, compared EQUAL and every skew check
 * passed. A value that stands for "I do not know" must not behave like a value.
 *
 * Callers must treat null as "not comparable" rather than as a version. That is
 * the same three-state rule the readers follow — a missing answer is not a
 * matching answer.
 */
export function scannerVersion() {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const h = createHash("sha256");
    for (const name of COUNTING_SOURCES) {
      h.update(name);
      h.update(readFileSync(join(dir, name)));
    }
    for (const [rel, name] of COUNTING_DATA) {
      h.update(name);
      h.update(readFileSync(join(dir, rel)));
    }
    return h.digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

function blank() {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
}

const intOr0 = (v) => (Number.isInteger(v) ? v : 0);

function isoToMs(s) {
  if (!s || typeof s !== "string") return NaN;
  return Date.parse(s);
}

function activeMinutes(stamps, threshold = MAX_ACTIVE_GAP_MIN) {
  const ts = stamps.map(isoToMs).filter(Number.isFinite).sort((a, b) => a - b);
  let mins = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = (ts[i] - ts[i - 1]) / 60000;
    if (gap > 0 && gap <= threshold) mins += gap;
  }
  return Math.round(mins * 10) / 10;
}

function mkRec(cli, sessionId, account, project) {
  return {
    cli,
    session_id: sessionId,
    account,
    project,
    start: null,
    end: null,
    turns: 0,
    tokens: blank(),
    _models: new Map(),
    _stamps: [],
  };
}

function noteTs(rec, ts) {
  rec._stamps.push(ts);
  if (rec.start === null || ts < rec.start) rec.start = ts;
  if (rec.end === null || ts > rec.end) rec.end = ts;
}

function vote(rec, model, n) {
  rec._models.set(model, (rec._models.get(model) ?? 0) + n);
}

export function finish(rec) {
  const stamps = rec._stamps ?? [];
  delete rec._stamps;
  rec.duration_min = activeMinutes(stamps);
  // The same session under a 1-minute threshold: the hard floor on how much
  // is unambiguously work rather than a gap someone chose to call work.
  rec.duration_tight_min = activeMinutes(stamps, 1);
  rec.elapsed_min = null;
  const a = isoToMs(rec.start), b = isoToMs(rec.end);
  if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
    rec.elapsed_min = Math.round(((b - a) / 60000) * 10) / 10;
  }
  const t = rec.tokens;
  rec.total = FIELDS.reduce((s, k) => s + t[k], 0);
  rec.sent = SENT_FIELDS.reduce((s, k) => s + t[k], 0);
  rec.received = t.output_tokens;
  const models = rec._models ?? new Map();
  delete rec._models;
  let best = null, bestN = -1;
  for (const [m, n] of models) if (n > bestN) { best = m; bestN = n; }
  rec.model = redactSecrets(best ?? "unknown");
  rec.models = {};
  for (const [m, n] of models) {
    const key = redactSecrets(String(m));
    rec.models[key] = (rec.models[key] ?? 0) + n;
  }
  rec.provider = providerOf(rec.model);
  rec.billed = isBilled(rec.cli, rec.provider);
  return rec;
}

// ---- fs helpers ------------------------------------------------------------

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
function listDirs(p) {
  let names;
  try { names = readdirSync(p).sort(); } catch { return []; }
  return names.map((n) => join(p, n)).filter(isDir);
}
function readTextSafe(p) {
  try { return readFileSync(p, "utf-8"); } catch { return null; }
}
function walkFiles(base, cb, depth = 16) {
  if (depth < 0) return;
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = join(base, e.name);
    if (e.isDirectory()) walkFiles(full, cb, depth - 1);
    else if (e.isFile()) cb(full);
  }
}
const stemOf = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
};

// ---- multi-root discovery --------------------------------------------------
// Look in the canonical place, honour XDG overrides, then walk home to depth 4
// for a directory of the same name anywhere else — a copied profile or a
// staging tree holds real tokens the live profile lost. Dedupe by realpath;
// session records dedupe by session_id later so copies merge, never double.

const SKIP_DIRS = new Set([
  "node_modules", ".git", "corpus", "merged", "token-corpus", "archive",
  "snap", ".cache", "venv", ".venv", "__pycache__", "site-packages",
  ".Trash", "Trash",
]);

// One home walk per process per home root, shared by every reader: collect
// every directory at depth <= 5 whose name matches any reader's leading
// component. (Python walks once per reader; identical results, less IO.)
let ALL_LEADS = new Set(); // filled after READERS is defined
const _walkCache = new Map(); // home -> Map(leadName -> [paths])

function homeLeadIndex(home) {
  const cached = _walkCache.get(home);
  if (cached) return cached;
  const found = new Map();
  const walk = (dir, depth) => {
    if (depth < 0) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue; // dirent dirs are never symlinks
      const full = join(dir, e.name);
      if (ALL_LEADS.has(e.name)) {
        if (!found.has(e.name)) found.set(e.name, []);
        found.get(e.name).push(full);
      }
      walk(full, depth - 1);
    }
  };
  walk(home, 4);
  _walkCache.set(home, found);
  return found;
}

export function toolRoots(home, rels) {
  const seen = new Set();
  const out = [];
  const add = (p) => {
    if (!isDir(p)) return;
    let key;
    try { key = realpathSync(p); } catch { key = p; }
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  const cleaned = rels.map((r) => r.replace(/^~\//, "").replace(/^\/+/, ""));
  for (const rel of cleaned) add(join(home, rel));

  for (const [envVar, prefix] of [
    ["XDG_CONFIG_HOME", ".config"],
    ["XDG_DATA_HOME", ".local/share"],
  ]) {
    const root = process.env[envVar];
    if (!root) continue;
    for (const rel of cleaned) {
      add(join(root, rel));
      if (rel.startsWith(prefix + "/")) add(join(root, rel.slice(prefix.length + 1)));
    }
  }

  // The leading component is the tool's own directory name — that is what the
  // home walk found; the rest of the path is re-applied beneath each hit.
  const wanted = new Map();
  for (const rel of cleaned) {
    const parts = rel.split("/");
    if (!wanted.has(parts[0])) wanted.set(parts[0], new Set());
    wanted.get(parts[0]).add(parts.slice(1).join("/"));
  }
  const index = homeLeadIndex(home);
  for (const [lead, tails] of wanted) {
    for (const hit of index.get(lead) ?? []) {
      for (const tail of tails) add(tail ? join(hit, tail) : hit);
    }
  }
  return out;
}

// ---- gemini — ~/.gemini/tmp/<projectHash>/chats/session-*.json|.jsonl ------

function* geminiDocs(text) {
  // Whole-file JSON, or JSONL where each line is a full session doc or a bare
  // message record. Unparseable lines are skipped, never abort the file.
  try {
    const d = JSON.parse(text);
    if (d && typeof d === "object" && !Array.isArray(d)) yield d;
    else yield { messages: d };
    return;
  } catch { /* fall through to line mode */ }
  const loose = [];
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    if (Array.isArray(o.messages)) yield o;
    else loose.push(o); // a bare message record
  }
  if (loose.length) yield { messages: loose };
}

function readGemini(home, base) {
  // Traps: `cached` (cachedContentTokenCount) is a SUBSET of `input` — adding
  // it inflates 83%; `total` == input+output+thoughts+tool — summing it is 2x.
  // Sessions are grouped by sessionId ACROSS files: one session checkpoints
  // across up to 12 files.
  const sessions = new Map();
  const files = new Set();
  walkFiles(base, (full) => {
    const name = basename(full);
    if (!name.endsWith(".json") && !name.endsWith(".jsonl")) return;
    if (name.startsWith("session-") || basename(dirname(full)) === "chats") {
      files.add(full);
    }
  });
  for (const f of [...files].sort()) {
    const text = readTextSafe(f);
    if (text === null) continue;
    for (const doc of geminiDocs(text)) {
      const sid =
        (typeof doc.sessionId === "string" && doc.sessionId) || stemOf(f);
      let rec = sessions.get(sid);
      if (!rec) {
        rec = mkRec(
          "gemini", sid, "gemini (local)",
          typeof doc.projectHash === "string" && doc.projectHash
            ? doc.projectHash
            : "-"
        );
        sessions.set(sid, rec);
      }
      const msgs = Array.isArray(doc.messages) ? doc.messages : [];
      for (const m of msgs) {
        if (!m || typeof m !== "object") continue;
        if (typeof m.timestamp === "string" && m.timestamp) noteTs(rec, m.timestamp);
        const t = m.tokens;
        if (!t || typeof t !== "object" || Array.isArray(t)) continue;
        rec.turns += 1; // only messages with a dict `tokens` count as turns
        if (typeof m.model === "string" && m.model) vote(rec, m.model, 1);
        const inp = intOr0(t.input);
        const cached = intOr0(t.cached);
        rec.tokens.input_tokens += Math.max(0, inp - cached) + intOr0(t.tool);
        rec.tokens.cache_read_input_tokens += Math.min(cached, inp);
        // Thinking tokens are generated and billed as output.
        rec.tokens.output_tokens += intOr0(t.output) + intOr0(t.thoughts);
      }
    }
  }
  return [...sessions.values()].filter((r) => r.turns > 0).map(finish);
}

// ---- copilot — ~/.copilot/session-state/ -----------------------------------

const COMPACT = {
  inputTokens: "input_tokens", input: "input_tokens",
  outputTokens: "output_tokens", output: "output_tokens",
  cacheReadTokens: "cache_read_input_tokens",
  cachedInput: "cache_read_input_tokens",
  cacheWriteTokens: "cache_creation_input_tokens",
};

function readCopilot(home, base) {
  // Authoritative usage lives ONLY in session.shutdown modelMetrics (plus the
  // compaction pass). truncation/currentTokens snapshots are context
  // bookkeeping (2.9x inflation) and assistant.message.outputTokens is already
  // inside the shutdown rollup. A session with no shutdown/compaction crashed:
  // no usage exists, it contributes nothing.
  const groups = new Map(); // sid -> [files]; nested AND flat layouts
  walkFiles(base, (full) => {
    if (!full.endsWith(".jsonl")) return;
    const parts = relative(base, full).split(sep);
    const key =
      parts.length === 1 && parts[0].endsWith(".jsonl")
        ? parts[0].slice(0, -6)
        : parts[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(full);
  });
  const out = [];
  for (const [sid, files] of [...groups.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1
  )) {
    const rec = mkRec("copilot", sid, "copilot (local)", "-");
    const byModel = new Map(); // model -> blank()
    const tgtFor = (m) => {
      if (!byModel.has(m)) byModel.set(m, blank());
      return byModel.get(m);
    };
    for (const f of files.sort()) {
      const text = readTextSafe(f);
      if (text === null) continue;
      for (const line of text.split("\n")) {
        if (!line.includes('"timestamp"')) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (!o || typeof o !== "object") continue;
        if (typeof o.timestamp === "string" && o.timestamp) noteTs(rec, o.timestamp);
        const typ = o.type;
        const d = o.data && typeof o.data === "object" ? o.data : {};
        if (typ === "assistant.message") {
          rec.turns += 1;
          vote(rec, typeof d.model === "string" && d.model ? d.model : "unknown", 1);
        } else if (typ === "session.shutdown") {
          const metrics =
            d.modelMetrics && typeof d.modelMetrics === "object" ? d.modelMetrics : {};
          for (const [model, m] of Object.entries(metrics)) {
            const u = m && typeof m === "object" && m.usage && typeof m.usage === "object"
              ? m.usage
              : {};
            const tgt = tgtFor(model);
            tgt.input_tokens += intOr0(u.inputTokens);
            // Reasoning tokens are generated and billed, and sit ALONGSIDE
            // outputTokens rather than inside it.
            tgt.output_tokens += intOr0(u.outputTokens) + intOr0(u.reasoningTokens);
            tgt.cache_read_input_tokens += intOr0(u.cacheReadTokens);
            tgt.cache_creation_input_tokens += intOr0(u.cacheWriteTokens);
          }
        } else if (typ === "session.compaction_complete") {
          // Two schema generations that never co-occur. Whitelisted keys and
          // int values ONLY: the same dict carries `duration` in ms — summing
          // every int adds phantom tokens.
          const tgt = tgtFor("compaction");
          const used =
            d.compactionTokensUsed && typeof d.compactionTokensUsed === "object"
              ? d.compactionTokensUsed
              : {};
          for (const [k, v] of Object.entries(used)) {
            if (COMPACT[k] && Number.isInteger(v)) tgt[COMPACT[k]] += v;
          }
        }
      }
    }
    if (byModel.size === 0) continue; // crashed session: no usage recorded
    for (const [model, t] of byModel) {
      for (const k of FIELDS) rec.tokens[k] += t[k];
      if (model !== "compaction") vote(rec, model, 1); // a bucket, not a model
    }
    out.push(finish(rec));
  }
  return out;
}

// ---- grok — ~/.grok/{sessions,archived_sessions}/<cwd>/<id>/updates.jsonl --

function readGrok(home, base) {
  // Count ONLY turn_completed: usage_snapshot carries the SAME field names
  // mid-turn and double-counts every turn. Top-level usage is the SUM over
  // modelUsage — fallback only. cachedReadTokens ⊂ inputTokens: split.
  const out = [];
  const sdirs = [];
  for (const p1 of listDirs(base)) for (const p2 of listDirs(p1)) sdirs.push(p2);
  sdirs.sort();
  for (const sdir of sdirs) {
    const f = join(sdir, "updates.jsonl");
    if (!isFile(f)) continue;
    let project = basename(dirname(sdir));
    try { project = decodeURIComponent(project); } catch { /* keep raw */ }
    const rec = mkRec("grok", basename(sdir), "grok (local)", maskPath(project));
    const text = readTextSafe(f);
    if (text === null) continue;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || typeof o !== "object") continue;
      let ts = o.timestamp;
      if (typeof ts === "number" && Number.isFinite(ts)) {
        // Epoch seconds if < 1e11 else milliseconds; normalize to ISO Z.
        try { ts = new Date(ts < 1e11 ? ts * 1000 : ts).toISOString(); } catch { ts = null; }
      }
      if (typeof ts === "string" && ts) noteTs(rec, ts);
      const params = o.params && typeof o.params === "object" ? o.params : {};
      const upd = params.update && typeof params.update === "object" ? params.update : {};
      if (upd.sessionUpdate !== "turn_completed") continue;
      const usage = upd.usage && typeof upd.usage === "object" ? upd.usage : {};
      const perModel =
        usage.modelUsage && typeof usage.modelUsage === "object" ? usage.modelUsage : {};
      const rows = Object.entries(perModel);
      if (rows.length === 0) rows.push(["grok", usage]); // top level only as fallback
      rec.turns += 1;
      for (const [model, u] of rows) {
        if (!u || typeof u !== "object") continue;
        vote(rec, model, 1);
        const inp = intOr0(u.inputTokens);
        const cached = intOr0(u.cachedReadTokens);
        rec.tokens.input_tokens += Math.max(0, inp - cached);
        rec.tokens.cache_read_input_tokens += Math.min(cached, inp);
        rec.tokens.output_tokens += intOr0(u.outputTokens); // reasoning is inside
      }
    }
    if (rec.turns) out.push(finish(rec));
  }
  return out;
}

// ---- kilo — VS Code extension kilocode.kilo-code ---------------------------

export function vscodeRoots(home) {
  const bases = [];
  if (process.platform === "darwin") bases.push(join(home, "Library", "Application Support"));
  else if (process.platform === "win32") {
    bases.push(process.env.APPDATA || join(home, "AppData", "Roaming"));
  }
  bases.push(join(home, ".config")); // Linux, and a fallback everywhere
  const out = [];
  for (const b of bases) {
    for (const name of ["Code", "Code - Insiders", "VSCodium", "Code - OSS"]) {
      const d = join(b, name);
      if (isDir(d)) out.push([name, d]);
    }
  }
  return out;
}

function kiloModel(tdir, provider) {
  const f = join(tdir, "api_conversation_history.json");
  const text = readTextSafe(f);
  if (text !== null) {
    const m = /<model>([^<]+)<\/model>/.exec(text.slice(0, 400000));
    if (m) return redactSecrets(m[1].split("/").pop());
  }
  return provider || "unknown";
}

function readKilo(home) {
  // Traps: tokensIn ALREADY INCLUDES cacheReads+cacheWrites (subtract both,
  // adding on top inflates 64%); state.vscdb taskHistory is a rollup restating
  // these same rows — per-request records ONLY. Every VS Code channel is
  // scanned: Insiders held the only Grok usage on the reference machine.
  const out = [];
  for (const [label, root] of vscodeRoots(home)) {
    const tasks = join(root, "User", "globalStorage", "kilocode.kilo-code", "tasks");
    if (!isDir(tasks)) continue;
    for (const tdir of listDirs(tasks)) {
      const f = join(tdir, "ui_messages.json");
      if (!isFile(f)) continue;
      let msgs;
      try { msgs = JSON.parse(readFileSync(f, "utf-8")); } catch { continue; }
      const rec = mkRec("kilocode", basename(tdir), `kilocode (${label})`, "-");
      let provider = null;
      for (const m of Array.isArray(msgs) ? msgs : []) {
        if (!m || typeof m !== "object") continue;
        if (typeof m.ts === "number" && Number.isFinite(m.ts)) {
          try { noteTs(rec, new Date(m.ts).toISOString()); } catch { /* bad epoch */ }
        }
        if (m.say !== "api_req_started") continue;
        let p;
        try { p = JSON.parse(m.text || "{}"); } catch { continue; }
        if (!p || typeof p !== "object") continue;
        const tin = intOr0(p.tokensIn);
        if (!tin && !intOr0(p.tokensOut)) continue; // aborted/streaming placeholder
        const cr = intOr0(p.cacheReads);
        const cw = intOr0(p.cacheWrites);
        rec.turns += 1;
        rec.tokens.input_tokens += Math.max(0, tin - cr - cw);
        rec.tokens.cache_read_input_tokens += cr;
        rec.tokens.cache_creation_input_tokens += cw;
        rec.tokens.output_tokens += intOr0(p.tokensOut);
        if (typeof p.inferenceProvider === "string" && p.inferenceProvider) {
          provider = p.inferenceProvider;
        }
      }
      if (!rec.turns) continue;
      vote(rec, kiloModel(tdir, provider), 1);
      const fin = finish(rec);
      fin.models = { [fin.model]: fin.turns };
      out.push(fin);
    }
  }
  return out;
}

// ---- antigravity — protobuf in SQLite + AES-256-GCM encrypted .pb ----------

// A string constant compiled into the `agy` binary — the same fixed key
// shipped to every user, which is why the files can be read at all.
const AGY_KEY = Buffer.from("safeCodeiumworldKeYsecretBalloon");
const AGY_UNCACHED = 2, AGY_OUTPUT = 3, AGY_CACHED = 5;
const AGY_OUT_A = 9, AGY_OUT_B = 10, AGY_REQUEST_ID = 11;
const AGY_MODEL_RE = /gemini[-_][0-9A-Za-z][0-9A-Za-z._\-]{0,26}/g;
const AGY_NOT_MODEL_RE = /\.(json|md|zip|txt|py|js)$|^gemini-cli/;

function pbVarint(b, i) {
  let r = 0, s = 0;
  for (;;) {
    if (i >= b.length) return null;
    const c = b[i++];
    r += (c & 0x7f) * 2 ** s;
    s += 7;
    if (!(c & 0x80)) return [r, i];
    if (s > 70) return null;
  }
}

// Parse one protobuf message level, or null. The parse must consume the
// buffer EXACTLY — without that, arbitrary binary decodes as a plausible
// message and yields enormous fake token counts (1.49e21 on first attempt).
function pbFields(b) {
  const d = new Map();
  let i = 0;
  while (i < b.length) {
    const t = pbVarint(b, i);
    if (!t) return null;
    let tag;
    [tag, i] = t;
    const fn = Math.floor(tag / 8), wt = tag % 8;
    if (fn === 0 || fn > 536870911) return null;
    let v;
    if (wt === 0) {
      const r = pbVarint(b, i);
      if (!r) return null;
      [v, i] = r;
    } else if (wt === 1) {
      if (i + 8 > b.length) return null;
      v = b.subarray(i, i + 8);
      i += 8;
    } else if (wt === 2) {
      const r = pbVarint(b, i);
      if (!r) return null;
      const [ln, j] = r;
      if (j + ln > b.length) return null;
      v = b.subarray(j, j + ln);
      i = j + ln;
    } else if (wt === 5) {
      if (i + 4 > b.length) return null;
      v = b.subarray(i, i + 4);
      i += 4;
    } else return null;
    if (!d.has(fn)) d.set(fn, []);
    d.get(fn).push(v);
  }
  return d;
}

function agyUsage(blob, out, depth = 0) {
  // Every ModelUsageStats (field 9) anywhere in a step's metadata, deduped on
  // the per-request server id — the same request appears in several steps.
  if (depth > 14) return out;
  const d = pbFields(blob);
  if (!d) return out;
  for (const [fn, vals] of d) {
    for (const v of vals) {
      if (!(v instanceof Uint8Array) || v.length < 2) continue;
      const inner = pbFields(v);
      if (!inner) continue;
      if (fn === 9) {
        const g = (k) => {
          const x = inner.get(k)?.[0];
          return typeof x === "number" && Number.isInteger(x) ? x : 0;
        };
        const unc = g(AGY_UNCACHED), o = g(AGY_OUTPUT), cac = g(AGY_CACHED);
        const a = g(AGY_OUT_A), bb = g(AGY_OUT_B);
        // Structural signature of a real usage record: output equals its two
        // components; everything else at field 9 is a coincidental match.
        if ((unc || o || cac) && a + bb === o && Math.max(unc, o, cac) < 50_000_000) {
          const rid = inner.get(AGY_REQUEST_ID)?.[0];
          const key =
            rid instanceof Uint8Array
              ? "r:" + Buffer.from(rid).toString("hex")
              : `t:${unc},${o},${cac},${a},${bb}`;
          out.set(key, [unc, o, cac]);
          continue;
        }
      }
      agyUsage(v, out, depth + 1);
    }
  }
  return out;
}

function agyTimes(blob, out, depth = 0) {
  // google.protobuf.Timestamp by shape: only fields {1,2}, <= 12 bytes,
  // plausible epoch second. Nested walk — .pb files bury per-step times.
  if (depth > 12) return out;
  const d = pbFields(blob);
  if (!d) return out;
  for (const vals of d.values()) {
    for (const v of vals) {
      if (!(v instanceof Uint8Array) || v.length < 2) continue;
      const inner = pbFields(v);
      if (!inner) continue;
      const sec = inner.get(1)?.[0];
      let onlyTs = true;
      for (const k of inner.keys()) if (k !== 1 && k !== 2) onlyTs = false;
      if (
        typeof sec === "number" && Number.isInteger(sec) &&
        sec > 1_500_000_000 && sec < 2_500_000_000 &&
        v.length <= 12 && onlyTs
      ) {
        out.push(sec);
      } else {
        agyTimes(v, out, depth + 1);
      }
    }
  }
  return out;
}

function agyDecrypt(raw) {
  // AES-256-GCM, 12-byte nonce prefix, 16-byte auth tag at the END of the
  // ciphertext (Python's AESGCM treats the tag as a suffix; Node splits it).
  try {
    if (raw.length < 12 + 16) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    // authTagLength SAID, not merely arithmetic. The tag is 16 bytes because
    // the slice above takes 16 bytes; nothing told the cipher that, so a
    // future edit to the slice would hand GCM a short tag and it would accept
    // it. 16 is already the default — this changes no behaviour and moves the
    // invariant from a subtraction into the API. (semgrep: gcm-no-tag-length)
    const dec = createDecipheriv("aes-256-gcm", AGY_KEY, iv, { authTagLength: 16 });
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(ct), dec.final()]);
  } catch {
    return null;
  }
}

function agyModelVotes(latin1, votes) {
  for (const m of latin1.matchAll(AGY_MODEL_RE)) {
    const raw = m[0];
    if (AGY_NOT_MODEL_RE.test(raw)) continue;
    const name = raw.replace(/[-._]+$/, "");
    if (name) votes.set(name, (votes.get(name) ?? 0) + 1);
  }
}

function agyNamedModel(rows) {
  // The model from gen_metadata, preferring the most specific id: longest,
  // which carries the tier suffix (gemini-3.6-flash-high over gemini-3.6-flash).
  const votes = new Map();
  for (const r of rows) {
    if (r == null) continue;
    const latin1 =
      typeof r === "string" ? r : Buffer.from(r).toString("latin1");
    agyModelVotes(latin1, votes);
  }
  let best = null;
  for (const [k, n] of votes) {
    if (!best || k.length > best[0].length || (k.length === best[0].length && n > best[1])) {
      best = [k, n];
    }
  }
  return best ? best[0] : null;
}

// -- minimal read-only SQLite (fallback when node:sqlite is unavailable) -----

function sqVarint(b, i) {
  let v = 0;
  for (let n = 0; n < 9; n++) {
    const c = b[i + n];
    if (c === undefined) throw new Error("varint eof");
    if (n === 8) return [v * 256 + c, i + 9];
    v = v * 128 + (c & 0x7f);
    if (!(c & 0x80)) return [v, i + n + 1];
  }
  throw new Error("varint overflow");
}

function sqDecodeRecord(payload) {
  let [hdrLen, i] = sqVarint(payload, 0);
  const types = [];
  while (i < hdrLen) {
    const [t, ni] = sqVarint(payload, i);
    types.push(t);
    i = ni;
  }
  let off = hdrLen;
  const vals = [];
  for (const t of types) {
    let size = 0, v = null;
    if (t === 0) { v = null; }
    else if (t >= 1 && t <= 6) {
      size = [0, 1, 2, 3, 4, 6, 8][t];
      if (size === 8) v = Number(payload.readBigInt64BE(off));
      else v = payload.readIntBE(off, size);
    } else if (t === 7) { size = 8; v = payload.readDoubleBE(off); }
    else if (t === 8) { v = 0; }
    else if (t === 9) { v = 1; }
    else if (t >= 12 && t % 2 === 0) { size = (t - 12) / 2; v = payload.subarray(off, off + size); }
    else if (t >= 13) { size = (t - 13) / 2; v = payload.toString("utf8", off, off + size); }
    vals.push(v);
    off += size;
  }
  return vals;
}

function sqColumnsFromSql(sql) {
  const open = sql.indexOf("(");
  if (open < 0) return [];
  let depth = 0, end = -1;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) { end = i; break; }
  }
  const body = sql.slice(open + 1, end < 0 ? sql.length : end);
  const parts = [];
  let cur = "", d = 0;
  for (const ch of body) {
    if (ch === "(") d++;
    else if (ch === ")") d--;
    if (ch === "," && d === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const CONSTRAINTS = new Set(["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT"]);
  const cols = [];
  for (const part of parts) {
    const tok = (part.trim().split(/\s+/)[0] ?? "").replace(/^["'`[]|["'`\]]$/g, "");
    if (!tok || CONSTRAINTS.has(tok.toUpperCase())) continue;
    cols.push(tok);
  }
  return cols;
}

export function sqliteColumnRaw(file, table, column) {
  const buf = readFileSync(file);
  if (buf.length < 100 || buf.toString("latin1", 0, 15) !== "SQLite format 3") {
    throw new Error("not a sqlite db");
  }
  let pageSize = buf.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  const usable = pageSize - buf[20];
  const page = (n) => buf.subarray((n - 1) * pageSize, n * pageSize);

  function walkTable(rootPage, cb) {
    const p = page(rootPage);
    const hdrOff = rootPage === 1 ? 100 : 0;
    const type = p[hdrOff];
    const nCells = p.readUInt16BE(hdrOff + 3);
    if (type === 5) {
      const ptrOff = hdrOff + 12;
      for (let c = 0; c < nCells; c++) {
        walkTable(p.readUInt32BE(p.readUInt16BE(ptrOff + 2 * c)), cb);
      }
      walkTable(p.readUInt32BE(hdrOff + 8), cb); // right-most child
    } else if (type === 13) {
      const ptrOff = hdrOff + 8;
      for (let c = 0; c < nCells; c++) {
        const off = p.readUInt16BE(ptrOff + 2 * c);
        const [plen, o1] = sqVarint(p, off);
        const [, o2] = sqVarint(p, o1); // rowid
        const X = usable - 35;
        let payload;
        if (plen <= X) {
          payload = p.subarray(o2, o2 + plen);
        } else {
          const M = Math.floor(((usable - 12) * 32) / 255) - 23;
          const K = M + ((plen - M) % (usable - 4));
          const local = K <= X ? K : M;
          const parts = [p.subarray(o2, o2 + local)];
          let next = p.readUInt32BE(o2 + local);
          let remaining = plen - local;
          while (next && remaining > 0) {
            const op = page(next);
            next = op.readUInt32BE(0);
            const take = Math.min(remaining, usable - 4);
            parts.push(op.subarray(4, 4 + take));
            remaining -= take;
          }
          payload = Buffer.concat(parts);
        }
        try { cb(sqDecodeRecord(payload)); } catch { /* skip bad row */ }
      }
    }
  }

  let rootpage = null, colIdx = -1;
  walkTable(1, (vals) => {
    if (vals[0] === "table" && vals[1] === table) {
      rootpage = Number(vals[3]);
      colIdx = sqColumnsFromSql(String(vals[4] ?? "")).indexOf(column);
    }
  });
  if (rootpage == null || colIdx < 0) throw new Error(`table ${table} not found`);
  const out = [];
  walkTable(rootpage, (vals) => {
    if (colIdx < vals.length) out.push(vals[colIdx]);
  });
  return out;
}

let _sqliteMod;
function sqliteColumn(file, table, column) {
  if (_sqliteMod === undefined) {
    try {
      _sqliteMod = createRequire(import.meta.url)("node:sqlite");
    } catch {
      _sqliteMod = null; // Node < 22.5 or flagged off: hand-rolled fallback
    }
  }
  if (_sqliteMod?.DatabaseSync) {
    const db = new _sqliteMod.DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(`SELECT "${column}" AS v FROM "${table}"`).all().map((r) => r.v);
    } finally {
      db.close();
    }
  }
  return sqliteColumnRaw(file, table, column);
}

function readAntigravity(home, base, note = {}) {
  // Only steps.metadata field 9 is read, deduped on the request id in field
  // 11: step_payload 5.9.*, metadata 28.2.*, gen_metadata 1.4.*/1.17.2.* are
  // all duplicates (reading everything = exactly 4.00x), and fields 9/10 are
  // components of 3. Fails SOFT: an unreadable conversation is reported,
  // never counted as zero.
  const out = [];
  let unreadable = 0;
  let names;
  try { names = readdirSync(base).sort(); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".db") && !name.endsWith(".pb")) continue;
    const f = join(base, name);
    const usage = new Map();
    const secs = [];
    const models = new Map();
    let blobs = [];
    if (name.endsWith(".db")) {
      try {
        const rows = sqliteColumn(f, "steps", "metadata");
        blobs = rows.filter((r) => r instanceof Uint8Array);
      } catch {
        unreadable += 1;
        continue;
      }
      try {
        const named = agyNamedModel(sqliteColumn(f, "gen_metadata", "data"));
        if (named) models.set(named, (models.get(named) ?? 0) + 1000); // authoritative
      } catch { /* no gen_metadata: model falls back to the blob scan */ }
    } else {
      let raw;
      try { raw = readFileSync(f); } catch { unreadable += 1; continue; }
      const plain = agyDecrypt(raw);
      if (plain === null) { unreadable += 1; continue; }
      blobs = [plain];
    }
    for (const b of blobs) {
      const bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
      agyUsage(bb, usage);
      agyModelVotes(bb.toString("latin1"), models); // fallback for .pb
      agyTimes(bb, secs);
    }
    if (usage.size === 0) continue;
    const stamps = [...new Set(secs)]
      .sort((a, b) => a - b)
      .map((s) => new Date(s * 1000).toISOString());
    let unc = 0, o = 0, cac = 0;
    for (const [u, oo, cc] of usage.values()) { unc += u; o += oo; cac += cc; }
    const rec = mkRec("antigravity", stemOf(f), "antigravity (local)", "-");
    rec.turns = usage.size;
    rec._models = models.size ? models : new Map([["antigravity", 1]]);
    rec._stamps = stamps;
    rec.tokens.input_tokens = unc;
    rec.tokens.cache_read_input_tokens = cac;
    rec.tokens.output_tokens = o;
    if (stamps.length) {
      rec.start = stamps[0];
      rec.end = stamps[stamps.length - 1];
    } else {
      // No decodable step times: file mtime with start == end, so duration
      // reads 0 ("not measured"), never an invented span.
      try {
        const ts = new Date(statSync(f).mtimeMs).toISOString();
        rec.start = rec.end = ts;
      } catch { /* leave null */ }
    }
    const fin = finish(rec);
    fin.models = { [fin.model]: fin.turns };
    out.push(fin);
  }
  note.unreadable = (note.unreadable ?? 0) + unreadable;
  return out;
}

// ---- registry + presence ---------------------------------------------------

// THE PATHS ARE NOT HERE ANY MORE. spec/sources.json declares where every
// source lives, per platform, and `probe()` walks it — so `sources`, the scan,
// the readers and this registry can no longer disagree about where one tool is.
// What stays is the READER: how to turn that tool's files into numbers, which
// is behaviour and belongs in code.
//
// `rels` survives only as the fallback for a source the spec does not name, so
// a half-installed package degrades to the old behaviour rather than counting
// nothing.
const READERS = {
  gemini: { rels: [".gemini/tmp"], read: readGemini },
  copilot: { rels: [".copilot/session-state"], read: readCopilot },
  antigravity: { rels: [".gemini/antigravity-cli/conversations"], read: readAntigravity },
  // `kilocode`, NOT `kilo`. This registry key was the only place in either
  // program that said `kilo`: deadreckon names the reader, the DETECT key and
  // the record value `kilocode`, this file already STAMPS `kilocode` on every
  // record it emits (readKilo, mkRec), the VS Code extension is
  // kilocode.kilo-code, and KNOWN_CLI_NAMES lists `kilocode`. The consequence
  // was silent in both directions: scanProvider("kilocode") threw on an
  // undefined registry entry, and an api_keys entry under `kilocode` could
  // never reach the reader it names.
  kilocode: { vscode: true, read: readKilo },
  grok: { rels: [".grok/sessions", ".grok/archived_sessions"], read: readGrok },
};

ALL_LEADS = new Set(
  Object.values(READERS).flatMap((c) => (c.rels ?? []).map((r) => r.split("/")[0]))
);

export const PROVIDERS = Object.keys(READERS);

// Presence is separate from counting: "not installed" vs "installed, no
// usage" vs "zero" stay distinct facts.
let _SPEC = null;
function specProbe(name, home) {
  _SPEC ??= loadSources();
  const src = _SPEC.sources.find((x) => x.name === name);
  return src ? probe(src, home, _SPEC) : null;
}

/**
 * Presence, from the declared stores.
 *
 * "not installed", "installed and idle" and "installed and unreadable" stay
 * three facts. The old version answered with `existsSync` on a path typed into
 * this file, so a store that was there and could not be entered reported
 * exactly like one that was not there — the largest defect class in this
 * program, 28 of the 106 confirmed on 2026-08-16.
 */
function detectInstalled(name, roots, probes) {
  if (probes) {
    for (const home of roots) {
      const pr = probes.get(`${name}\0${home}`);
      if (pr && (pr.present || pr.unreadable.length)) return true;
    }
    return false;
  }
  for (const home of roots) {
    if (name === "kilocode") {
      for (const [, root] of vscodeRoots(home)) {
        if (isDir(join(root, "User", "globalStorage", "kilocode.kilo-code"))) return true;
      }
    } else {
      for (const rel of READERS[name].rels ?? []) {
        if (existsSync(join(home, rel))) return true;
      }
    }
  }
  return false;
}

// ---- public API ------------------------------------------------------------

export function scanProvider(name, roots = [homedir()]) {
  const cfg = READERS[name];
  if (!cfg) throw new Error(`unknown provider: ${name}`);
  // One probe per (source, root), reused for presence and for the row's state
  // so the walk happens once and both answers come from the same look.
  const probes = new Map();
  for (const home of roots) {
    const pr = specProbe(name, home);
    if (pr) probes.set(`${name}\0${home}`, pr);
  }
  const sessions = [];
  const seen = new Set(); // copied profiles merge, never double-count
  const note = { unreadable: 0 };
  let error = null;
  for (const home of roots) {
    let recs = [];
    if (cfg.vscode) {
      try {
        recs = cfg.read(home) || [];
      } catch (e) {
        error = error ?? maskText(String(e?.message ?? e));
      }
    } else {
      for (const base of toolRoots(home, cfg.rels)) {
        try {
          recs.push(...(cfg.read(home, base, note) || []));
        } catch (e) {
          error = error ?? maskText(String(e?.message ?? e));
        }
      }
    }
    for (const rec of recs) {
      // Kilo keys on account+id so distinct VS Code channels stay distinct
      // while a copied home merges.
      const key = name === "kilocode" ? `${rec.account}:${rec.session_id}` : rec.session_id;
      if (key != null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      sessions.push(rec);
    }
  }

  const row = {
    sessions: sessions.length,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    models: {},
    firstTs: null,
    lastTs: null,
    installed: detectInstalled(name, roots, probes.size ? probes : null),
  };
  // THE STATE, FROM THE SAME PROBE. `installed` is a boolean and there are
  // four answers; a store that is present and cannot be entered was reporting
  // exactly like one that is not there.
  if (probes.size) {
    const all = [...probes.values()];
    const blind = all.flatMap((pr) => pr.unreadable);
    row.state = blind.length ? "unreadable"
      : stateOf({ present: all.some((pr) => pr.present), unreadable: [] }, sessions.length);
    if (blind.length) row.unreadable = blind.map((u) => `${maskPath(u.path)} (${u.why})`);
    row.searched = all.flatMap((pr) => pr.searched).length;
  }
  // ALWAYS AN ARRAY OF LINES. This field arrived as three different types —
  // a count (antigravity), a string (the ported readers) and an array (the
  // probe) — and the terminal renderer called .slice() on it, which threw on a
  // real scan the moment a store was genuinely unreadable. A field whose type
  // depends on which reader filled it is a field every consumer has to guess
  // about.
  if (name === "antigravity" && note.unreadable)
    row.unreadable = [`${note.unreadable} conversation(s) could not be decoded`];
  if (error) row.error = error;
  const perSession = [];
  for (const s of sessions) {
    const t = s.tokens;
    row.input += t.input_tokens;
    row.output += t.output_tokens;
    row.cacheRead += t.cache_read_input_tokens;
    row.cacheWrite += t.cache_creation_input_tokens;
    for (const [m, n] of Object.entries(s.models ?? {})) {
      row.models[m] = (row.models[m] ?? 0) + n;
    }
    if (s.start && (!row.firstTs || s.start < row.firstTs)) row.firstTs = s.start;
    if (s.end && (!row.lastTs || s.end > row.lastTs)) row.lastTs = s.end;
    perSession.push({
      provider: name,
      session_id: s.session_id,
      month: s.start ? s.start.slice(0, 7) : null,
      input: t.input_tokens,
      output: t.output_tokens,
      cacheRead: t.cache_read_input_tokens,
      cacheWrite: t.cache_creation_input_tokens,
      model: s.model,
      vendor: s.provider, // cli and provider are separate dimensions
      billed: s.billed,
      turns: s.turns,
      duration_min: s.duration_min,
      duration_tight_min: s.duration_tight_min,
      account: s.account,
      project: s.project,
    });
  }
  return { providers: { [name]: row }, perSession };
}

export function scanAllProviders(roots = [homedir()]) {
  const providers = {};
  const perSession = [];
  for (const name of PROVIDERS) {
    const r = scanProvider(name, roots);
    providers[name] = r.providers[name];
    perSession.push(...r.perSession);
  }
  return { providers, perSession, scanner_version: scannerVersion() };
}

// ── the ported readers ────────────────────────────────────────────────────────

/**
 * The four readers ported from deadreckon, aggregated into the same row shape
 * scanProvider produces so every downstream consumer — the star, the card, the
 * stats page, the JSON report, the ledger — sees them without being taught
 * anything new.
 *
 * SEPARATE FROM scanAllProviders BECAUSE ONE OF THEM IS ASYNC. `bob` is SQLite,
 * and node:sqlite has to be imported lazily (it is a builtin, so this still
 * costs no dependency, but it arrived in Node 22.5 and must degrade rather than
 * throw). Making scanAllProviders async would have rippled through its callers
 * and two suites for one reader's benefit; this keeps the existing path exactly
 * as it was and adds a second, awaited call beside it.
 *
 * `knownClaudeIds` IS REQUIRED AND MUST BE THE LIVE CLAUDE SESSIONS. The orphan
 * reader recovers sessions whose transcripts were deleted, and it identifies
 * them by SUBTRACTING the ones still on disk. Hand it an empty set and every
 * live session is counted a second time — on the machine this was ported from
 * that is 4,172,332,033 tokens of double count.
 *
 * A row carries `state` as well as `installed`, because `installed` is a
 * boolean and there are four answers: absent, empty, counted, unreadable. The
 * last one matters most — a store that is present and could not be read must
 * never render as a tool nobody uses.
 */
export async function scanPortedReaders(roots = [homedir()], { knownClaudeIds } = {}) {
  if (!(knownClaudeIds instanceof Set)) {
    throw new TypeError(
      "scanPortedReaders: knownClaudeIds must be the Set of Claude session ids "
      + "found on disk by this scan. Without it the orphan reader re-counts "
      + "every live session.");
  }
  const { readClaudeOrphans, readClawspring, readLmstudio, readBob,
          readCopilotChat, readHistory } = await import("./readers.mjs");

  const providers = {};
  const perSession = [];

  // EVERY ROOT, AND EACH SESSION ONCE.
  //
  // This read roots[0] and `break`ed, under a comment saying extra roots were
  // "merged by the caller". They were not: the caller merges what it is handed,
  // and it was handed one root's worth. Measured before the fix — two roots
  // holding 1,000 and 2,000 clawspring tokens returned 1,000 — so the five
  // ported readers and `history` silently skipped every root but the first
  // whenever --roots named more than one.
  //
  // Summing roots blindly is the opposite defect, and this project has already
  // paid for it: four copied profiles counted as four machines' work,
  // 37,196,921,021 against a true 11,414,194,297. A session id is the identity
  // here as it is everywhere else, so a session seen under two roots is ONE
  // session and the larger reading of it wins — a partial copy cannot lower the
  // total, and a complete copy cannot raise it.
  const historySeen = new Map();      // history session id -> row, across roots
  let historyPrompts = 0, historyEarliest = null, historyLatest = null;
  let historyState = "absent";
  const perProvider = new Map();      // provider -> Map(session_id -> session)
  const providerMeta = new Map();     // provider -> { state, installed, unreadable[] }
  const totalOf = (t) => (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
  // Which state wins when roots disagree: a store that was READ somewhere is
  // not absent, and "could not read it here" outranks "not here at all".
  const STATE_RANK = { counted: 4, empty: 3, unreadable: 2, absent: 1 };

  const add = (name, r) => {
    const row = {
      sessions: r.sessions.length,
      input: r.tokens.input,
      output: r.tokens.output,
      cacheRead: r.tokens.cacheRead,
      cacheWrite: r.tokens.cacheWrite,
      models: {},
      firstTs: null,
      lastTs: null,
      // absent is the only state that means "not on this machine". empty and
      // unreadable both mean the store IS here.
      installed: r.state !== "absent",
      state: r.state,
    };
    if (r.state === "unreadable" || (r.unreadable ?? []).length) {
      // The reader's own list wins when it has one: readCopilotChat names each
      // file it could not open, which is more use than "something failed".
      const list = Array.isArray(r.unreadable) && r.unreadable.length
        ? r.unreadable.map((u) =>
            typeof u === "string" ? maskPath(u) : `${maskPath(u.path)} (${u.why})`)
        : (r.probe?.unreadable ?? []).map((u) => `${maskPath(u.path)} (${u.why})`);
      row.unreadable = list.length ? list : [maskText(String(r.why ?? "could not be read"))];
    }
    // Meta merges across roots; the numbers below are rebuilt from the deduped
    // sessions afterwards rather than accumulated here, so a session counted
    // twice cannot reach the row at all.
    const meta = providerMeta.get(name) ?? { state: "absent", installed: false, unreadable: [] };
    if ((STATE_RANK[row.state] ?? 0) > (STATE_RANK[meta.state] ?? 0)) meta.state = row.state;
    meta.installed = meta.installed || row.installed;
    if (row.unreadable) meta.unreadable.push(...row.unreadable);
    providerMeta.set(name, meta);
    if (!perProvider.has(name)) perProvider.set(name, new Map());
    const bucket = perProvider.get(name);
    for (const s of r.sessions) {
      const prev = bucket.get(s.id);
      // Larger reading wins: two roots holding the same session are the same
      // work seen twice, and the fuller copy is the true one.
      if (prev && totalOf(prev.tokens) >= totalOf(s.tokens)) continue;
      bucket.set(s.id, s);
    }
  };

  // One home at a time: these readers take a home directory, not a root list.
  for (const home of roots) {
    add("claude-orphans", readClaudeOrphans(home, knownClaudeIds));
    add("clawspring", readClawspring(home));
    add("lmstudio", readLmstudio(home));
    add("bob", await readBob(home));
    add("copilot-chat", readCopilotChat(home));

    // HISTORY IS NOT A TOKEN READER AND IS NOT GIVEN TOKEN FIELDS.
    //
    // history.jsonl records that a session existed, when, and in which project.
    // It holds no usage counters at all, so it gets its own row shape: session
    // and prompt counts, a date range, and NO token buckets. `add()` above
    // would read `r.tokens.input` and turn "this format has no counters" into
    // four zeroes that sum into the fleet total as though they were measured.
    //
    // It earns its place because it OUTLIVES THE TRANSCRIPTS: on the machine
    // this was ported from it reaches back to 2026-01-14, where the oldest
    // surviving transcript is 2026-05-05. It cannot say what those months cost;
    // it can prove they happened, which turns "we may have lost some" into a
    // count with dates on it.
    // MERGED ACROSS ROOTS, not overwritten by the last one. history.jsonl is
    // per-home: each root has its own, and assigning here once per root meant
    // the final root's file replaced every earlier one. Session ids dedup the
    // same way the token readers do; the date range widens to cover them all.
    const h = readHistory(home);
    for (const hs of h.sessions ?? []) {
      const id = hs?.id ?? hs?.session_id ?? JSON.stringify(hs);
      if (!historySeen.has(id)) historySeen.set(id, hs);
    }
    historyPrompts += h.prompts ?? 0;
    if (h.earliest && (!historyEarliest || h.earliest < historyEarliest)) historyEarliest = h.earliest;
    if (h.latest && (!historyLatest || h.latest > historyLatest)) historyLatest = h.latest;
    if ((STATE_RANK[h.state] ?? 0) > (STATE_RANK[historyState] ?? 0)) historyState = h.state;
  }

  providers["history"] = {
    sessions: historySeen.size,
    prompts: historyPrompts,
    earliest: historyEarliest,
    latest: historyLatest,
    installed: historyState !== "absent",
    state: historyState,
    counts_tokens: false,
  };

  // Rebuild each provider row from the sessions that survived the dedup, so the
  // published row and the per-session list can never disagree about what was
  // counted — they are two views of one map rather than two accumulations.
  for (const [name, bucket] of perProvider) {
    const meta = providerMeta.get(name) ?? { state: "absent", installed: false, unreadable: [] };
    const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const s of bucket.values())
      for (const k of Object.keys(sum)) sum[k] += s.tokens[k] ?? 0;
    providers[name] = {
      sessions: bucket.size, ...sum, models: {}, firstTs: null, lastTs: null,
      installed: meta.installed, state: meta.state,
      ...(meta.unreadable.length ? { unreadable: meta.unreadable } : {}),
    };
    for (const s of bucket.values()) {
      perSession.push({
        provider: name,
        session_id: s.id,
        month: null,
        input: s.tokens.input,
        output: s.tokens.output,
        cacheRead: s.tokens.cacheRead,
        cacheWrite: s.tokens.cacheWrite,
        model: s.model ?? "unknown",
        vendor: s.cli === "claude" ? "anthropic" : null,
        billed: s.billed !== false,
        turns: 0,
        duration_min: 0,
        duration_tight_min: 0,
        account: null,
        project: s.project ?? null,
      });
    }
  }

  return { providers, perSession };
}

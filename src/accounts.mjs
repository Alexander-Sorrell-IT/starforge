// Per-account token attribution + the FLOOR metric.
// Faithful port of the Python token-usage system:
//   analyze_tokens.py  find_config_dirs / account_for / iter_usage / scan
//   sessions.py        read_stats_cache
//   stats_page.py      machine_floor
// Core semantics preserved exactly:
//   - Profiles are discovered by SHAPE (a dir whose projects/ holds >=1 .jsonl
//     anywhere beneath it), never by name. Name-glob first (live profiles win
//     the dedup race), then $CLAUDE_CONFIG_DIR (real home only), then a walk of
//     home to depth 4 skipping COPY_DIRS and symlinks.
//   - Message dedup is ONE uuid set spanning every config dir on the machine;
//     that is the only thing that makes greedy discovery safe (copied profile
//     trees contribute zero).
//   - Account identity: oauthAccount.emailAddress, else "user:"+userID[:12],
//     else "unknown (<dirname>)". The dir literally named ".claude" keeps its
//     config at <home>/.claude.json, NOT inside the dir.
// ONE deliberate departure from the Python: the identity that leaves this
// module is PSEUDONYMISED by default (see displayAccount below). accountFor()
// still returns the raw address — callers that only print to the terminal use
// it — but every row/fleet record this module hands to a writer carries
// "acct-<8 hex>" unless the caller opts into raw with { showAccounts: true }
// (`--show-accounts` on the CLI).
//   - Floor: per ACCOUNT (profiles folded first, counter applied exactly once),
//     max(counterTotal + transcript tokens on days strictly after
//     lastComputedDate, measured on disk). Concatenation is exact; subtraction
//     is meaningless. dailyModelTokens is never used (input+output only).
import { sanitizeModel } from "./scan.mjs";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  createReadStream,
} from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { maskPath, redactSecrets, accountPseudonym } from "./redact.mjs";

// The four billed usage counters: JSONL key -> output key. usage.iterations
// restates these for multi-step turns and is deliberately never summed.
const USAGE_FIELDS = [
  ["input_tokens", "input"],
  ["cache_creation_input_tokens", "cacheWrite"],
  ["cache_read_input_tokens", "cacheRead"],
  ["output_tokens", "output"],
];

// stats-cache.json modelUsage counters (camelCase) -> output key.
const CACHE_FIELDS = [
  ["inputTokens", "input"],
  ["outputTokens", "output"],
  ["cacheReadInputTokens", "cacheRead"],
  ["cacheCreationInputTokens", "cacheWrite"],
];

const TOK_KEYS = ["input", "output", "cacheRead", "cacheWrite"];

// Dirs that hold COPIES of transcripts rather than a live profile. Reading
// them is not wrong (global dedup makes a copy contribute nothing) but walking
// them is a waste, so they are skipped by name — same list as the Python.
const COPY_DIRS = new Set([
  "corpus", "merged", "token-corpus", "node_modules", ".git",
  "archive", "snap", ".cache", ".local", "venv", ".venv",
]);

function zeroTok() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function grand(t) {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

function addTok(dst, src) {
  for (const k of TOK_KEYS) dst[k] += src[k] || 0;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function sameDir(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function expandUser(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Names matching pathlib's home.glob(".*claude*"): leading dot, "claude"
// somewhere after it.
function claudeGlobNames(home) {
  let names = [];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(".") && n.slice(1).includes("claude"))
    .sort();
}

// ---- profile discovery (analyze_tokens.find_config_dirs) -------------------

// Lazy shape test: at least one *.jsonl anywhere under dir, first hit wins.
function hasJsonlBeneath(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  const subdirs = [];
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isFile() && name.endsWith(".jsonl")) return true;
    if (st.isDirectory()) subdirs.push(full);
  }
  for (const d of subdirs) if (hasJsonlBeneath(d)) return true;
  return false;
}

function looksLikeProfile(dir) {
  const proj = join(dir, "projects");
  return isDir(proj) && hasJsonlBeneath(proj);
}

// Every Claude Code config dir under `home`, found by SHAPE not by name.
// Order matters: glob'd live profiles come first, so a copy found by the walk
// only contributes what the live profile already lost.
export function findConfigDirs(home) {
  const seenReal = new Set();
  const out = [];

  const add = (p) => {
    let key;
    try {
      key = realpathSync(p);
    } catch {
      return;
    }
    if (seenReal.has(key)) return;
    if (!looksLikeProfile(p)) return;
    seenReal.add(key);
    out.push(p);
  };

  // 1. The fast, common case first.
  for (const name of claudeGlobNames(home)) {
    const p = join(home, name);
    if (isDir(p)) add(p);
  }

  // 2. $CLAUDE_CONFIG_DIR — honoured ONLY when scanning the real home, so a
  //    home override (tests) is never polluted by the live environment.
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && sameDir(home, homedir())) add(expandUser(env));

  // 3. Walk home to depth 4 so nested copies are reached.
  const walk = (root, depth) => {
    if (depth < 0 || !isDir(root)) return;
    let kids;
    try {
      kids = readdirSync(root).sort();
    } catch {
      return;
    }
    for (const name of kids) {
      const d = join(root, name);
      let st;
      try {
        st = lstatSync(d);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory() || COPY_DIRS.has(name))
        continue;
      if (isDir(join(d, "projects"))) add(d);
      walk(d, depth - 1);
    }
  };
  walk(home, 4);
  return out;
}

// ---- account identity (analyze_tokens.account_for) -------------------------

function configJson(configDir, home) {
  // The ~/.claude quirk: the default profile keeps its state in
  // <home>/.claude.json, not <home>/.claude/.claude.json. Keyed on the dir
  // NAME, exactly like the Python (a copy named ".claude" resolves the same).
  const cfg =
    basename(configDir) === ".claude"
      ? join(home, ".claude.json")
      : join(configDir, ".claude.json");
  try {
    return JSON.parse(readFileSync(cfg, "utf-8"));
  } catch {
    return null;
  }
}

// Three tiers, strongest first. A profile with no email is real usage: never
// skipped, never collapsed with other unknowns.
export function accountFor(configDir, home) {
  const data = configJson(configDir, home);
  if (data && typeof data === "object") {
    const email = data.oauthAccount?.emailAddress;
    if (email && typeof email === "string") return email;
    const uid = data.userID;
    if (uid && typeof uid === "string") return "user:" + uid.slice(0, 12);
  }
  return `unknown (${basename(configDir)})`;
}

// The identity as it may appear in a FILE. Default: a stable pseudonym, because
// reports / the stats page / a --join-fleet folder all get synced or shared and
// an OAuth email address is the user's real-world name. Raw is opt-in.
//
// Only the two tiers that identify a PERSON or an account are pseudonymised —
// the email tier and the "user:<uid>" tier. The "unknown (<dirname>)" fallback
// is a local directory name that the row already carries verbatim in its masked
// configDir field, so hashing it would hide nothing and cost readability.
// The mapping is deterministic, so grouping, the floor metric, and cross-machine
// merges behave exactly as they do with raw identities.
export function displayAccount(identity, showAccounts = false) {
  const id = String(identity ?? "");
  if (showAccounts) return id;
  if (id.includes("@") || id.startsWith("user:")) return accountPseudonym(id);
  return id;
}

// ---- transcript scan (analyze_tokens.scan / iter_usage) --------------------

function listJsonl(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, r);
      else if (st.isFile() && name.endsWith(".jsonl"))
        out.push({ path: full, rel: r });
    }
  };
  walk(root, "");
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

async function streamLines(filePath, onLine) {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  let n = 0;
  for await (const line of rl) {
    if (line) onLine(line);
    if ((++n & 2047) === 0) await new Promise((r) => setImmediate(r));
  }
}

// Aggregate one config dir. `seen` is the machine-wide uuid set, passed IN so
// dedup spans every config dir — the one thing that makes broad discovery
// safe. Only lines containing '"usage"' are parsed; a truncated final line of
// a live session fails JSON.parse and is silently skipped; non-integer usage
// values skip that field only; records without a uuid are counted
// unconditionally (cannot dedup, cannot skip).
async function scanProfile(configDir, seen) {
  const totals = zeroTok();
  const byDay = new Map(); // "YYYY-MM-DD" -> tok
  const byModel = new Map(); // model id -> tok; partitions totals EXACTLY
  const sessionRows = []; // one row per transcript file, sums match totals
  let sessions = 0;

  const root = join(configDir, "projects");
  for (const { path, rel } of listJsonl(root)) {
    const parts = rel.split("/");
    // main = anything not nested under subagents/ or workflows/; each nested
    // transcript is its own billed API conversation and counts toward totals,
    // but only main files count as sessions.
    if (!parts.includes("workflows") && !parts.includes("subagents"))
      sessions += 1;
    const fileTok = zeroTok();
    const modelCounts = new Map();
    let turns = 0;
    let firstTs = null;
    let lastTs = null;
    try {
      await streamLines(path, (line) => {
        if (!line.includes('"usage"')) return;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          return; // truncated final line of a live session
        }
        const msg = rec?.message;
        const usage = msg && typeof msg === "object" ? msg.usage : null;
        if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
        const uuid = rec.uuid;
        if (uuid) {
          if (seen.has(uuid)) return;
          seen.add(uuid);
        }
        const ts = typeof rec.timestamp === "string" ? rec.timestamp : "";
        const day = ts.slice(0, 10);
        let dayTok = null;
        if (day) {
          dayTok = byDay.get(day);
          if (!dayTok) byDay.set(day, (dayTok = zeroTok()));
        }
        const model =
          // sanitizeModel, as scan.mjs and profile.mjs both do for this exact
          // field. Read raw, a model value that is really a filesystem path or
          // a credential went straight into the per-account rollup files.
          sanitizeModel(msg.model) || "unknown";
        let modelTok = byModel.get(model);
        if (!modelTok) byModel.set(model, (modelTok = zeroTok()));
        modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
        turns += 1;
        if (ts) {
          if (!firstTs || ts < firstTs) firstTs = ts;
          if (!lastTs || ts > lastTs) lastTs = ts;
        }
        for (const [key, out] of USAGE_FIELDS) {
          const v = usage[key];
          if (!Number.isInteger(v)) continue;
          totals[out] += v;
          if (dayTok) dayTok[out] += v;
          modelTok[out] += v;
          fileTok[out] += v;
        }
      });
    } catch {
      // unreadable file: skip it, keep the profile
    }
    if (turns > 0) {
      let topModel = "";
      let topCount = 0;
      for (const [m, c] of modelCounts)
        if (c > topCount) [topModel, topCount] = [m, c];
      const durMin =
        firstTs && lastTs
          ? Math.max(
              0,
              (Date.parse(lastTs) - Date.parse(firstTs)) / 60000
            ) || 0
          : 0;
      sessionRows.push({
        session_id: rel.split("/").pop().replace(/\.jsonl$/, ""),
        turns,
        start: firstTs,
        end: lastTs,
        duration_min: +durMin.toFixed(1),
        model: topModel,
        tok: fileTok,
      });
    }
  }
  return { totals, byDay, byModel, sessions, sessionRows };
}

// ---- frozen counter (sessions.read_stats_cache) ----------------------------

// Claude Code's own lifetime counter, which outlives the transcripts. Read
// from glob'd .*claude* dirs like the Python. Summed fields are ONLY
// modelUsage's four billed counters; dailyModelTokens is input+output only
// (399x smaller) and is never touched.
export function readStatsCache(home) {
  const out = [];
  for (const name of claudeGlobNames(home)) {
    const dir = join(home, name);
    const file = join(dir, "stats-cache.json");
    if (!isDir(dir) || !isFile(file)) continue;
    let d;
    try {
      d = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    const mu =
      d?.modelUsage && typeof d.modelUsage === "object" ? d.modelUsage : {};
    const tok = zeroTok();
    for (const v of Object.values(mu)) {
      if (!v || typeof v !== "object") continue;
      for (const [key, outKey] of CACHE_FIELDS) {
        const n = v[key];
        if (typeof n === "number" && isFinite(n)) tok[outKey] += n;
      }
    }
    // Per-model breakdown, same four billed counters summed per model as
    // sessions.read_stats_cache. His machine_floor needs the record; his
    // stats page shows by_model, so it is carried, not just the grand total.
    const byModel = {};
    let inputOutputOnly = 0;
    for (const [model, v] of Object.entries(mu)) {
      if (!v || typeof v !== "object") continue;
      let n = 0;
      for (const [key] of CACHE_FIELDS) {
        const x = v[key];
        if (typeof x === "number" && isFinite(x)) n += x;
      }
      byModel[model] = n;
      const i = v.inputTokens;
      const o = v.outputTokens;
      if (typeof i === "number" && isFinite(i)) inputOutputOnly += i;
      if (typeof o === "number" && isFinite(o)) inputOutputOnly += o;
    }
    out.push({
      profile: name,
      account: redactSecrets(accountFor(dir, home)),
      tok,
      total: grand(tok),
      byModel,
      inputOutputOnly,
      totalSessions: Number.isInteger(d.totalSessions) ? d.totalSessions : null,
      totalMessages: Number.isInteger(d.totalMessages) ? d.totalMessages : null,
      firstSession:
        typeof d.firstSessionDate === "string"
          ? d.firstSessionDate.slice(0, 10)
          : null,
      lastComputed:
        typeof d.lastComputedDate === "string" ? d.lastComputedDate : null,
    });
  }
  return out;
}

// ---- discoverAccounts + floor (stats_page.machine_floor) -------------------

// Scan every Claude Code config root on this machine (or opts.home). Returns
// one row per profile:
//   { configDir (masked), account,
//     onDisk: {input,output,cacheRead,cacheWrite,sessions},
//     floor: {input,output,cacheRead,cacheWrite} | null }
// The floor is ACCOUNT-level — profiles are folded first and the frozen
// counter applied exactly once per account — and is attached to the FIRST row
// of each account (discovery order); every other row of that account, and any
// account with no counter, carries floor: null. floorTotals() treats a null
// floor as "measured on disk is all we know".
export async function discoverAccounts(opts = {}) {
  const home = opts.home ?? homedir();
  const showAccounts = opts.showAccounts === true;
  const dirs = findConfigDirs(home);
  const seen = new Set(); // ONE uuid set for the whole machine
  const rows = [];
  const merged = new Map(); // account -> { tok, days, byModel, sessionRows, ... }
  // display label -> raw identity. NEVER written to a file: the caller uses it
  // to print the terminal table, which is the one output that is not a file.
  const identities = new Map();

  for (const dir of dirs) {
    const raw = redactSecrets(accountFor(dir, home));
    const account = displayAccount(raw, showAccounts);
    identities.set(account, raw);
    const { totals, byDay, byModel, sessions, sessionRows } =
      await scanProfile(dir, seen);
    rows.push({
      configDir: maskPath(String(dir)),
      account,
      onDisk: { ...totals, sessions },
      floor: null,
    });
    let g = merged.get(account);
    if (!g)
      merged.set(
        account,
        (g = {
          tok: zeroTok(),
          days: new Map(),
          byModel: new Map(),
          sessionRows: [],
          sessions: 0,
          configDir: maskPath(String(dir)),
        })
      );
    addTok(g.tok, totals);
    g.sessions += sessions;
    for (const r of sessionRows) g.sessionRows.push({ ...r, account });
    for (const [m, t] of byModel) {
      let mt = g.byModel.get(m);
      if (!mt) g.byModel.set(m, (mt = zeroTok()));
      addTok(mt, t);
    }
    for (const [day, t] of byDay) {
      let dt = g.days.get(day);
      if (!dt) g.days.set(day, (dt = zeroTok()));
      addTok(dt, t);
    }
  }

  // Counter lookup by ACCOUNT; like the Python dict comprehension, a later
  // glob entry for the same account overwrites an earlier one.
  // Keyed by the DISPLAY label so the join still lands after pseudonymisation
  // (the mapping is deterministic, so this is the same partition either way).
  const counterByAcct = new Map();
  for (const e of readStatsCache(home))
    counterByAcct.set(displayAccount(e.account, showAccounts), e);

  // Per-account floor: "the counter owns everything up to its end date, the
  // transcripts own the days strictly after it, and no token is in both."
  // Plain string comparison, both sides YYYY-MM-DD. Clamped so the floor is
  // never below what was measured on disk.
  const floors = new Map();
  for (const [account, g] of merged) {
    const e = counterByAcct.get(account);
    if (e && e.lastComputed) {
      const after = zeroTok();
      for (const [day, t] of g.days) {
        if (day > e.lastComputed) addTok(after, t);
      }
      const concat = zeroTok();
      addTok(concat, e.tok);
      addTok(concat, after);
      floors.set(account, grand(concat) >= grand(g.tok) ? concat : { ...g.tok });
    } else {
      floors.set(account, null);
    }
  }

  const claimed = new Set();
  for (const row of rows) {
    const f = floors.get(row.account);
    if (f && !claimed.has(row.account)) {
      row.floor = f;
      claimed.add(row.account);
    }
  }
  if (!opts.fleet) return rows;

  // Fleet-interchange view: one entry per ACCOUNT in the shape
  // fleet.writeMachineFolder expects (long field names, by_model partitioning
  // totals exactly by construction — both sides incremented from the same
  // integers), plus per-transcript session rows whose sums equal the totals.
  const toLong = (t) => ({
    input_tokens: t.input,
    cache_creation_input_tokens: t.cacheWrite,
    cache_read_input_tokens: t.cacheRead,
    output_tokens: t.output,
  });
  const fleetAccounts = [];
  const fleetSessions = [];
  for (const [account, g] of merged) {
    if (grand(g.tok) === 0 && g.sessions === 0) continue;
    const by_model = {};
    for (const [m, t] of g.byModel) by_model[m] = toLong(t);
    // by_day is what stats_page.machine_floor uses to find the transcript days
    // strictly AFTER the frozen counter's lastComputedDate. Omitting it makes
    // his pipeline fall back to on-disk only and understate the floor.
    const by_day = {};
    for (const day of [...g.days.keys()].sort()) by_day[day] = toLong(g.days.get(day));
    fleetAccounts.push({
      account,
      config_dir: g.configDir,
      sessions: g.sessions,
      turns: g.sessionRows.reduce((a, r) => a + r.turns, 0),
      totals: toLong(g.tok),
      by_model,
      by_day,
    });
    for (const r of g.sessionRows) {
      fleetSessions.push({
        cli: "claude",
        session_id: r.session_id,
        account,
        turns: r.turns,
        start: r.start,
        end: r.end,
        duration_min: r.duration_min,
        model: r.model,
        tokens: toLong(r.tok),
      });
    }
  }
  // The frozen counters, in sessions.read_stats_cache's own record shape, so
  // stats_page.machine_floor can concatenate counter + post-counter days.
  const fleetStatsCache = readStatsCache(home).map((e) => ({
    profile: e.profile,
    account: displayAccount(e.account, showAccounts),
    total: e.total,
    input_output_only: e.inputOutputOnly,
    by_model: e.byModel,
    sessions: e.totalSessions,
    messages: e.totalMessages,
    first_session: e.firstSession,
    last_computed: e.lastComputed,
  }));

  // `identities` is terminal-only (display label -> raw address). Callers must
  // never write it: everything else in this object is already pseudonymised.
  return {
    rows,
    fleetAccounts,
    fleetSessions,
    fleetStatsCache,
    identities: [...identities.entries()].map(([account, identity]) => ({
      account,
      identity,
    })),
    showAccounts,
  };
}

// Fleet-style rollup across account rows. onDisk sums every profile; floor
// sums one figure per ACCOUNT: its floor object if one row carries it, else
// the account's measured on-disk totals (floor must never fall below what was
// measured).
export function floorTotals(accounts) {
  const onDisk = { ...zeroTok(), sessions: 0 };
  const byAcct = new Map();
  for (const row of accounts ?? []) {
    const t = row?.onDisk ?? {};
    addTok(onDisk, t);
    onDisk.sessions += t.sessions || 0;
    let g = byAcct.get(row.account);
    if (!g) byAcct.set(row.account, (g = { tok: zeroTok(), floor: null }));
    addTok(g.tok, t);
    if (row.floor) g.floor = row.floor;
  }
  const floor = zeroTok();
  for (const g of byAcct.values()) addTok(floor, g.floor ?? g.tok);
  return { onDisk, floor };
}

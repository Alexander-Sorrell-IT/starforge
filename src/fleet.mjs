// Fleet merge + interchange format for the token-usage repo.
// Faithful JS port of the Python system's semantics: combine.py (merge),
// paths.py (layout), stats_page.machine_floor (floor), analyze_tokens
// .provider_of (vendor split), update.py archive() (snapshot dedup), and the
// writer contract check_consistency.py enforces. The Python code is the spec;
// nothing here invents different arithmetic.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import os from "node:os";
import { maskPath, maskText } from "./redact.mjs";

// The four usage counters, in the order they are reported everywhere.
export const FIELDS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
];

const HUMAN = "human-readable";
const MACHINE = "machine-readable";

// Files a person edits in the token-usage repo. Never written by this module.
const AUTHORED = new Set([
  "machines.json", "accounts.json", "README.md",
  ".gitignore", ".gitattributes", ".fleet-reset.json",
]);

// Directory names that are never machine folders (paths.machine_folders).
const NON_MACHINE_DIRS = new Set([
  HUMAN, MACHINE, "archive", "corpus", "merged",
  "digests", "dist", "docker", "__pycache__", "testing-archive",
]);

// model-id prefix -> vendor (analyze_tokens.PROVIDER_PREFIXES, same order —
// first match wins, so "claude" must be tried before nothing else claims it).
const PROVIDER_PREFIXES = [
  ["claude", "anthropic"],
  ["deepseek", "deepseek"],
  ["gemini", "google"],
  ["gemma", "google"],
  ["antigravity", "antigravity"],
  ["copilot", "copilot"],
  ["gpt", "openai"],
  ["o1", "openai"], ["o3", "openai"], ["o4", "openai"], ["codex", "openai"],
  ["grok", "xai"],
  ["llama", "meta"],
  ["mistral", "mistral"], ["mixtral", "mistral"],
  ["qwen", "qwen"],
  ["kimi", "moonshot"],
  ["glm", "zhipu"],
];

export function providerOf(model) {
  const m = (model || "").toLowerCase();
  for (const [prefix, vendor] of PROVIDER_PREFIXES) {
    if (m.startsWith(prefix)) return vendor;
  }
  if (m === "<synthetic>" || m === "unknown" || m === "") return "synthetic";
  return "other";
}

// ---- layout (paths.py) -----------------------------------------------------

// A generated file, wherever it currently is: machine-readable/ first, then
// human-readable/, then the old flat layout. Absent and "moved" must not look
// the same — that exact bug recurred four times in the Python repo.
function findGenerated(base, name) {
  for (const c of [join(base, MACHINE, name), join(base, HUMAN, name), join(base, name)]) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // keep looking
    }
  }
  return null;
}

// Every machine folder under root, old layout or new: any subdir (outside the
// reserved set) holding a findable totals.json.
function machineFolders(root) {
  let entries;
  try {
    entries = readdirSync(root).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (NON_MACHINE_DIRS.has(entry) || entry === ".git") continue;
    const dir = join(root, entry);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (findGenerated(dir, "totals.json")) out.push(dir);
  }
  return out;
}

function readJson(file) {
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

// ---- small numeric helpers -------------------------------------------------

const zero4 = () => ({
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
});

// Accepts either canonical field names or starforge's short tok keys
// ({in,cw,cr,out}); always returns a full 4-field dict — combine.py indexes
// v[k] for all four unconditionally, so a missing field is a pipeline crash.
const ALIASES = {
  input_tokens: "in",
  cache_creation_input_tokens: "cw",
  cache_read_input_tokens: "cr",
  output_tokens: "out",
};

function fill4(v) {
  const o = zero4();
  if (v && typeof v === "object") {
    for (const k of FIELDS) {
      const raw = v[k] ?? v[ALIASES[k]];
      const n = Number(raw);
      if (Number.isFinite(n)) o[k] = n;
    }
  }
  return o;
}

const sum4 = (v) => FIELDS.reduce((a, k) => a + (v[k] || 0), 0);

// generated_at is timezone-LOCAL ISO with offset (matches the Python fleet),
// while session start/end stay UTC Z — check_consistency compares them as
// strings, so the conventions must not be mixed the other way.
export function localIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const a = Math.abs(tz);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.trunc(a / 60))}:${p(a % 60)}`
  );
}

// ---- floor (stats_page.machine_floor) --------------------------------------

// The most defensible single figure for one machine. The stats-cache counter
// owns everything up to its last_computed date; the transcripts own the days
// STRICTLY after it — concatenation, never subtraction, so no token lands in
// both windows. The counter is per ACCOUNT: every profile of an account is
// folded together BEFORE it is applied, exactly once (per-profile lookup
// quintuple-counted a 12.29B counter in the Python repo).
export function machineFloor(m, sessionsHere = [], statsCacheHere = []) {
  const val = (v) =>
    typeof v === "number"
      ? v
      : v && typeof v === "object"
        ? Object.values(v).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0)
        : 0;

  const byAcct = new Map();
  for (const e of statsCacheHere) byAcct.set(e.account, e);

  // Per-account session totals, so a floor is never below what was measured.
  const perAcctSess = new Map();
  for (const x of sessionsHere) {
    if (x.cli === "claude") {
      perAcctSess.set(x.account, (perAcctSess.get(x.account) || 0) + (x.total || 0));
    }
  }

  const merged = new Map();
  for (const a of m.accounts || []) {
    let g = merged.get(a.account);
    if (!g) merged.set(a.account, (g = { days: new Map(), grand: 0 }));
    for (const [k, v] of Object.entries(a.by_day || {})) {
      g.days.set(k, (g.days.get(k) || 0) + val(v));
    }
    g.grand += a.grand_total || 0;
  }

  let claude = 0;
  const rows = [];
  for (const [name, g] of merged) {
    const seen = Math.max(g.grand, perAcctSess.get(name) || 0);
    const e = byAcct.get(name);
    let part;
    if (e && e.last_computed) {
      let after = 0;
      for (const [k, v] of g.days) if (k > e.last_computed) after += v;
      part = Math.max((e.total || 0) + after, seen);
      rows.push({ account: name, counter: e.total, last_computed: e.last_computed, after, part });
    } else {
      part = seen;
      rows.push({ account: name, counter: null, last_computed: null, after: part, part });
    }
    claude += part;
  }
  rows.sort((a, b) => b.part - a.part);
  let other = 0;
  for (const x of sessionsHere) if (x.cli !== "claude") other += x.total || 0;
  return { floor: claude + other, claude, other, rows };
}

// ---- readFleet (combine.py merge semantics) --------------------------------

export function readFleet(tokenUsageDir) {
  const root = tokenUsageDir;
  const warnings = [];
  const empty = {
    generatedAt: localIso(),
    machines: [],
    accounts: [],
    byProvider: {},
    byMachineProvider: {},
    byCli: {},
    cliByProvider: {},
    uncountableTools: [],
    missingAccounts: [],
    fleetTotals: { onDisk: 0, floor: 0 },
    warnings,
  };
  if (!root || !existsSync(root)) return empty;

  // a) discovery — every folder with a findable totals.json.
  const machines = [];
  for (const dir of machineFolders(root)) {
    const m = readJson(findGenerated(dir, "totals.json"));
    if (!m || typeof m.grand_total_tokens !== "number" || !Array.isArray(m.accounts) || !m.machine) {
      warnings.push(`skipped ${basename(dir)}: totals.json unreadable or missing required fields`);
      continue;
    }
    m.folder = basename(dir);
    // Optional — a machine folder is still valid without hardware.json.
    const hw = readJson(findGenerated(dir, "hardware.json"));
    if (hw) m.hw = hw;
    machines.push(m);
  }
  if (machines.length === 0) return empty;
  machines.sort((a, b) => b.grand_total_tokens - a.grand_total_tokens);

  // Fleet roster + account registry (both AUTHORED, both optional).
  const fleet = readJson(join(root, "machines.json"))?.machines ?? [];
  const registry = readJson(join(root, "accounts.json")) ?? {};
  const knownAccounts = registry.accounts ?? [];
  const profileLabels = {};
  for (const p of registry.profiles ?? []) {
    if (p.userID) profileLabels[p.userID] = p.label || p.userID;
  }

  // b) relabel bare user:<uid> rows — the uid in the account string is
  // truncated, so match profiles[].userID on prefix. Unmatched rows stay as-is.
  for (const m of machines) {
    for (const a of m.accounts) {
      if (typeof a.account !== "string" || !a.account.startsWith("user:")) continue;
      const uid = a.account.slice(5);
      for (const [full, label] of Object.entries(profileLabels)) {
        if (full.startsWith(uid)) {
          a.account = label;
          break;
        }
      }
    }
  }

  // c) per-account rollup across machines. Sessions on different computers are
  // disjoint, so these add without double-counting. "machines" is keyed by
  // machine NAME and ACCUMULATED, never appended per profile — appending
  // reported one account as spanning 9 computers on a 5-computer fleet.
  const perAccount = new Map();
  for (const m of machines) {
    for (const a of m.accounts) {
      let acct = perAccount.get(a.account);
      if (!acct) {
        perAccount.set(a.account, (acct = {
          total: 0, sessions: 0, turns: 0,
          machines: new Map(), fields: zero4(), models: new Map(), days: new Set(),
        }));
      }
      acct.total += a.grand_total || 0;
      acct.sessions += a.sessions || 0;
      acct.turns += a.turns || 0;
      acct.machines.set(m.machine, (acct.machines.get(m.machine) || 0) + (a.grand_total || 0));
      for (const k of FIELDS) acct.fields[k] += a.totals?.[k] || 0;
      for (const [model, v] of Object.entries(a.by_model || {})) {
        acct.models.set(model, (acct.models.get(model) || 0) + sum4(v));
      }
      for (const day of Object.keys(a.by_day || {})) acct.days.add(day);
    }
  }
  const grand = machines.reduce((a, m) => a + m.grand_total_tokens, 0);

  // d) provider split from totals.json by_model — deliberately NOT from
  // sessions.json, so a machine that never ran the session scanner still shows.
  const prov = new Map();
  const provMachine = new Map();
  for (const m of machines) {
    let row = provMachine.get(m.machine);
    if (!row) provMachine.set(m.machine, (row = new Map()));
    for (const a of m.accounts) {
      for (const [model, v] of Object.entries(a.by_model || {})) {
        const p = providerOf(model);
        const n = sum4(v);
        prov.set(p, (prov.get(p) || 0) + n);
        row.set(p, (row.get(p) || 0) + n);
      }
    }
  }

  // f) cross-CLI section: concatenate sessions.json across machines. A folder
  // WITHOUT sessions.json is skipped, not treated as zero — absent and zero
  // are different facts, and the result names which machines are missing.
  const allSessions = [];
  const scannedSessions = new Set();
  const allClis = new Map();
  const uncountable = new Map();
  const statsCacheByMachine = new Map();
  for (const dir of machineFolders(root)) {
    const d = readJson(findGenerated(dir, "sessions.json"));
    if (!d) continue;
    const name = d.machine || basename(dir);
    scannedSessions.add(name);
    statsCacheByMachine.set(name, d.stats_cache || []);
    for (const r of d.readers || []) {
      let e = allClis.get(r.cli);
      if (!e) allClis.set(r.cli, (e = { installed_on: [], absent_on: [] }));
      (r.installed ? e.installed_on : e.absent_on).push(name);
    }
    for (const s of d.sessions || []) {
      s.machine = name;
      allSessions.push(s);
    }
    for (const u of d.uncountable_tools || []) {
      const k = u.tool;
      const prev = uncountable.get(k);
      if (!prev || (u.files || 0) > (prev.files || 0)) {
        uncountable.set(k, { ...u, machine: name });
      }
    }
  }
  const byCli = new Map();
  const cliByProv = new Map();
  for (const c of allClis.keys()) byCli.set(c, { sessions: 0, tokens: 0, active_min: 0 });
  for (const s of allSessions) {
    for (const [agg, key] of [[byCli, s.cli], [cliByProv, s.provider]]) {
      const k = key || "-";
      let e = agg.get(k);
      if (!e) agg.set(k, (e = { sessions: 0, tokens: 0, active_min: 0 }));
      e.sessions += 1;
      e.tokens += s.total || 0;
      e.active_min += s.duration_min || 0;
    }
  }

  // g) FLOOR per machine: counter concatenated with post-counter transcript
  // days plus non-claude CLI tokens. No sessions.json ⇒ floor falls back to
  // the measured figure (statscache empty, sessions empty).
  const floors = new Map();
  for (const m of machines) {
    const mine = allSessions.filter((s) => s.machine === m.machine);
    try {
      floors.set(m.machine, machineFloor(m, mine, statsCacheByMachine.get(m.machine) || []).floor);
    } catch {
      floors.set(m.machine, null);
    }
  }
  let fleetFloor = 0;
  for (const v of floors.values()) if (v) fleetFloor += v;

  // e) registered-but-never-scanned machines: both folder AND label must be
  // absent from the scanned sets. They contribute 0 to every number, which is
  // the point of naming them — every total is a floor until they are in.
  const have = new Set();
  for (const m of machines) {
    have.add(m.folder);
    have.add(m.machine);
  }
  const rosterLabel = new Map(fleet.map((e) => [e.folder, e.label]));
  const machineRows = machines.map((m) => {
    const hw = m.hw?.hardware || null;
    return {
      folder: m.folder,
      machine: m.machine,
      label: rosterLabel.get(m.folder) ?? m.machine,
      total: m.grand_total_tokens,
      accounts: m.accounts.length,
      scanned: m.generated_at ?? null,
      sessionsScanned: scannedSessions.has(m.machine),
      neverScanned: false,
      floor: floors.get(m.machine) ?? null,
      hardware: hw
        ? {
            chip: hw.chip ?? null,
            cpu_logical: hw.cpu_logical ?? null,
            memory_gb: hw.memory_gb ?? null,
            os: hw.os ?? null,
          }
        : null,
    };
  });
  for (const e of fleet) {
    if (have.has(e.folder) || have.has(e.label)) continue;
    machineRows.push({
      folder: e.folder ?? null,
      machine: e.label ?? e.folder ?? null,
      label: e.label ?? e.folder ?? null,
      total: 0,
      accounts: 0,
      scanned: null,
      sessionsScanned: false,
      neverScanned: true,
      floor: null,
      hardware: null,
    });
  }

  // Known accounts not substring-present (case-insensitive) in any rolled-up
  // account name — signed in somewhere that has never been scanned.
  const seenNames = [...perAccount.keys()].join(" ").toLowerCase();
  const missingAccounts = knownAccounts
    .filter((a) => a.email && !seenNames.includes(a.email.toLowerCase()))
    .map((a) => a.email);

  const accountRows = [...perAccount.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, a]) => {
      const days = [...a.days].sort();
      return {
        account: name,
        total: a.total,
        sessions: a.sessions,
        turns: a.turns,
        byMachine: Object.fromEntries(a.machines),
        totals: a.fields,
        byModel: Object.fromEntries([...a.models.entries()].sort((x, y) => y[1] - x[1])),
        activeDays: days.length,
        firstDay: days[0] ?? null,
        lastDay: days[days.length - 1] ?? null,
      };
    });

  const provEntries = [...prov.entries()].filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
  return {
    generatedAt: localIso(),
    machines: machineRows,
    accounts: accountRows,
    byProvider: Object.fromEntries(provEntries),
    byMachineProvider: Object.fromEntries(
      [...provMachine.entries()].map(([mn, row]) => [mn, Object.fromEntries(row)])
    ),
    byCli: Object.fromEntries(
      [...byCli.entries()]
        .sort((a, b) => b[1].tokens - a[1].tokens)
        .map(([k, e]) => [k, { ...e, active_min: Math.round(e.active_min * 10) / 10 }])
    ),
    cliByProvider: Object.fromEntries(
      [...cliByProv.entries()]
        .sort((a, b) => b[1].tokens - a[1].tokens)
        .map(([k, e]) => [k, { ...e, active_min: Math.round(e.active_min * 10) / 10 }])
    ),
    uncountableTools: [...uncountable.values()],
    missingAccounts,
    fleetTotals: { onDisk: grand, floor: fleetFloor },
    warnings,
  };
}

// ---- writer (interchange the Python pipeline accepts) ----------------------

const DEFAULT_SCANNER_VERSION = createHash("sha256")
  .update("starforge-fleet-1")
  .digest("hex")
  .slice(0, 12);

function normalizeAccount(src, i) {
  if (!src || typeof src !== "object") throw new Error(`accounts[${i}] is not an object`);
  let account = src.account;
  if (!account && typeof src.user_id === "string") account = "user:" + src.user_id.slice(0, 12);
  if (typeof account !== "string" || !account) {
    throw new Error(`accounts[${i}] needs account (email or user:<12-hex>) or user_id`);
  }
  const totals = fill4(src.totals);
  const grand = sum4(totals);
  const byModel = {};
  for (const [model, v] of Object.entries(src.by_model || {})) byModel[model] = fill4(v);
  if (Object.keys(byModel).length === 0 && grand > 0) {
    throw new Error(`account ${account}: by_model is required when totals are non-zero — ` +
      "a raw sum counts non-Anthropic backends as Anthropic");
  }
  const modelSum = Object.values(byModel).reduce((a, v) => a + sum4(v), 0);
  if (modelSum !== grand) {
    throw new Error(`account ${account}: by_model sums to ${modelSum} but totals sum to ${grand} — ` +
      "check_consistency.py fails on exact-integer mismatch");
  }
  const byDay = {};
  for (const day of Object.keys(src.by_day || {}).sort()) byDay[day] = fill4(src.by_day[day]);
  const byKind = src.by_kind
    ? Object.fromEntries(Object.entries(src.by_kind).map(([k, v]) => [k, fill4(v)]))
    : { main: { ...totals }, subagent: zero4() };
  const byProvider = {};
  for (const [model, v] of Object.entries(byModel)) {
    const p = providerOf(model);
    const cur = byProvider[p] ?? (byProvider[p] = zero4());
    for (const k of FIELDS) cur[k] += v[k];
  }
  const byProject = {};
  for (const [slug, v] of Object.entries(src.by_project || {})) byProject[maskText(slug)] = fill4(v);
  const sessions = Number(src.sessions) || 0;
  // Exact key order of analyze_tokens.py output — archive dedup compares bytes.
  return {
    config_dir: maskPath(src.config_dir ?? "~/.claude"),
    sessions,
    files: src.files ?? { main: sessions, subagent: 0 },
    turns: Number(src.turns) || 0,
    totals,
    by_kind: byKind,
    by_provider: byProvider,
    by_model: byModel,
    by_day: byDay,
    by_project: byProject,
    account,
    user_id: src.user_id ?? null,
    identity: src.identity ?? {
      auth: account.includes("@") ? "oauth" : "unknown",
      email: account.includes("@") ? account : null,
    },
    grand_total: grand,
  };
}

function normalizeSession(src, i, defaultAccount) {
  const tokens = fill4(src.tokens);
  const total = sum4(tokens);
  const sent =
    tokens.input_tokens + tokens.cache_creation_input_tokens + tokens.cache_read_input_tokens;
  const received = tokens.output_tokens;
  const provider = src.provider ?? providerOf(src.model);
  const dur = Number(src.duration_min) || 0;
  return {
    cli: src.cli ?? "claude",
    session_id: src.session_id ?? `session-${i}`,
    account: src.account ?? defaultAccount ?? "-",
    project: maskText(src.project ?? "-"),
    start: src.start ?? null,
    end: src.end ?? null,
    turns: Number(src.turns) || 0,
    tokens,
    duration_min: dur,
    duration_tight_min: Number(src.duration_tight_min) || dur,
    elapsed_min: Number(src.elapsed_min) || dur,
    total,
    sent,
    received,
    model: src.model ?? "",
    provider,
    billed: src.billed ?? provider === "anthropic",
  };
}

// Hardware via node:os, shaped like check_hardware.py's hardware.json.
export function gatherHardware(label) {
  let hostname = null;
  let hardware = {};
  try {
    hostname = os.hostname();
    const cpus = os.cpus() || [];
    hardware = {
      model_identifier: typeof os.machine === "function" ? os.machine() : os.arch(),
      chip: (cpus[0]?.model || "").trim() || os.arch(),
      cpu_logical: cpus.length || null,
      memory_gb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
      os: `${os.type()} ${os.release()}`,
    };
  } catch {
    // a partial record is still a record
  }
  return {
    machine: label ?? hostname,
    hostname,
    hardware,
    node: process.version,
  };
}

function platformString() {
  try {
    return `${os.type()}-${os.release()}-${typeof os.machine === "function" ? os.machine() : os.arch()}`;
  } catch {
    return "unknown";
  }
}

function writeJson(file, obj) {
  // Match python json.dumps(obj, indent=2): same shape, insertion order kept,
  // no trailing newline — the archive digest compares bytes.
  writeFileSync(file, JSON.stringify(obj, null, 2), "utf-8");
}

// Write a VALID machine folder the Python pipeline accepts: .machine-id at the
// folder root, totals.json / sessions.json / hardware.json under
// machine-readable/, and a human-readable/REPORT.md stub so combine's link
// resolves. Throws on any arithmetic the check_consistency.py gate would fail.
export function writeMachineFolder(tokenUsageDir, folderName, data = {}) {
  if (!folderName || /[/\\]/.test(folderName) || folderName.startsWith(".")) {
    throw new Error(`invalid machine folder name: ${folderName}`);
  }
  if (NON_MACHINE_DIRS.has(folderName) || AUTHORED.has(folderName)) {
    throw new Error(`${folderName} is a reserved name, not a machine folder`);
  }
  const label = data.label ?? folderName;
  const generatedAt =
    data.generatedAt instanceof Date
      ? localIso(data.generatedAt)
      : data.generatedAt ?? localIso();
  const scannerVersion = data.scannerVersion ?? DEFAULT_SCANNER_VERSION;

  const accounts = (data.accounts ?? []).map((a, i) => normalizeAccount(a, i));
  const grandTotal = accounts.reduce((a, x) => a + x.grand_total, 0);

  // Top-level provider split (ints), derived from every account's by_model so
  // the provider partition sums to grand exactly.
  const byProvider = {};
  for (const a of accounts) {
    for (const [model, v] of Object.entries(a.by_model)) {
      const p = providerOf(model);
      byProvider[p] = (byProvider[p] || 0) + sum4(v);
    }
  }

  const sessions = (data.sessions ?? []).map((s, i) =>
    normalizeSession(s, i, accounts[0]?.account)
  );
  // The cross-check that matters most: two views of the same transcripts must
  // agree per machine. A single-pass writer has no live-session drift excuse,
  // so they must agree EXACTLY or check_consistency.py fails the whole run.
  if (sessions.length) {
    const claudeSum = sessions
      .filter((s) => s.cli === "claude")
      .reduce((a, s) => a + s.total, 0);
    if (claudeSum !== grandTotal) {
      throw new Error(
        `claude session totals sum to ${claudeSum} but accounts sum to ${grandTotal} — ` +
          "check_consistency.py tolerates drift only for sessions still being written"
      );
    }
  }

  const totalsDoc = {
    machine: label,
    generated_at: generatedAt,
    scanner_version: scannerVersion,
    anthropic_only_tokens: byProvider.anthropic ?? 0,
    by_provider: byProvider,
    other_tools: data.otherTools ?? [],
    grand_total_tokens: grandTotal,
    accounts,
  };

  // readers: seed one row per CLI seen (always claude) so a tool with zero
  // surviving sessions is a zero row rather than missing from the report.
  let readers = data.readers ?? null;
  if (!readers) {
    const byCliAgg = new Map([["claude", { sessions: 0, tokens: 0, active_min: 0 }]]);
    for (const s of sessions) {
      let e = byCliAgg.get(s.cli);
      if (!e) byCliAgg.set(s.cli, (e = { sessions: 0, tokens: 0, active_min: 0 }));
      e.sessions += 1;
      e.tokens += s.total;
      e.active_min += s.duration_min;
    }
    readers = [...byCliAgg.entries()].map(([cli, e]) => ({
      cli,
      sessions: e.sessions,
      tokens: e.tokens,
      active_min: Math.round(e.active_min * 10) / 10,
      installed: true,
      looked_in: [],
      error: null,
    }));
  }
  const firstLast = {};
  for (const s of sessions) {
    if (!s.start) continue;
    const e = firstLast[s.cli] ?? (firstLast[s.cli] = { first: s.start, last: s.end ?? s.start, sources: [] });
    if (s.start < e.first) e.first = s.start;
    if ((s.end ?? s.start) > e.last) e.last = s.end ?? s.start;
  }

  const statsCache = (data.statsCache ?? []).map((e) => ({
    profile: e.profile ?? null,
    account: e.account,
    total: Number(e.total) || 0,
    input_output_only: Number(e.input_output_only) || 0,
    by_model: e.by_model ?? {},
    sessions: Number(e.sessions) || 0,
    messages: Number(e.messages) || 0,
    first_session: e.first_session ?? null,
    last_computed: e.last_computed ?? null,
  }));

  const sessionsDoc = {
    machine: label,
    generated_at: generatedAt,
    scanner_version: scannerVersion,
    scanner_features: data.scannerFeatures ?? ["claude"],
    uncountable_tools: data.uncountableTools ?? [],
    readers,
    first_last_seen: firstLast,
    inventory: data.inventory ?? [],
    history_ledger: data.historyLedger ?? [],
    stats_cache: statsCache,
    sessions,
  };

  const hardwareDoc = data.hardware ?? gatherHardware(label);
  if (hardwareDoc?.disk?.volume) hardwareDoc.disk.volume = maskPath(hardwareDoc.disk.volume);
  for (const a of hardwareDoc?.accounts ?? []) {
    if (a.config_dir) a.config_dir = maskPath(a.config_dir);
  }

  const folder = join(tokenUsageDir, folderName);
  const mrDir = join(folder, MACHINE);
  const hrDir = join(folder, HUMAN);
  mkdirSync(mrDir, { recursive: true });
  mkdirSync(hrDir, { recursive: true });

  writeJson(join(mrDir, "totals.json"), totalsDoc);
  writeJson(join(mrDir, "sessions.json"), sessionsDoc);
  writeJson(join(mrDir, "hardware.json"), hardwareDoc);

  // .machine-id claims the folder permanently, so a later Python run on this
  // computer resolves to the same folder instead of guessing.
  writeFileSync(
    join(folder, ".machine-id"),
    JSON.stringify(
      { hostname: hardwareDoc.hostname ?? os.hostname(), folder: folderName, label, platform: platformString() },
      null,
      1
    ) + "\n",
    "utf-8"
  );

  // combine.py links every machine row to <folder>/human-readable/REPORT.md;
  // write a stub only if nothing is there so a real report is never clobbered.
  const report = join(hrDir, "REPORT.md");
  if (!existsSync(report)) {
    writeFileSync(
      report,
      `# ${label}\n\nWritten by starforge (fleet.mjs) ${generatedAt}.\n` +
        `Grand total: ${grandTotal.toLocaleString("en-US")} tokens across ${accounts.length} account(s).\n` +
        `Data lives in ../machine-readable/.\n`,
      "utf-8"
    );
  }

  return {
    dir: folder,
    files: ["machine-readable/totals.json", "machine-readable/sessions.json",
            "machine-readable/hardware.json", ".machine-id", "human-readable/REPORT.md"],
    label,
    grandTotal,
  };
}

// ---- archive (update.py archive() snapshot + dedup) ------------------------

export function archiveStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

// sha256 over concat(filename bytes + file bytes) in the given order, first 12
// hex — byte-for-byte the Python scheme, so JS and Python snapshots dedup
// against each other. Returns null when no file exists (an empty payload).
export function snapshotDigest(files) {
  const hash = createHash("sha256");
  let any = false;
  for (const f of files) {
    let bytes;
    try {
      bytes = readFileSync(f);
    } catch {
      continue;
    }
    any = true;
    hash.update(basename(f));
    hash.update(bytes);
  }
  return any ? hash.digest("hex").slice(0, 12) : null;
}

function snap(srcFiles, destDir) {
  const present = srcFiles.filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });
  const digest = snapshotDigest(present);
  if (!digest) return null;
  // Compare only against the LEXICALLY LAST existing sibling snapshot.
  const parent = join(destDir, "..");
  try {
    const sibs = readdirSync(parent)
      .filter((e) => {
        try {
          return statSync(join(parent, e)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
    if (sibs.length) {
      const prev = join(parent, sibs[sibs.length - 1], ".digest");
      try {
        if (readFileSync(prev, "utf-8").trim() === digest) return null;
      } catch {
        // no digest recorded there — treat as changed
      }
    }
  } catch {
    // no sibling snapshots yet
  }
  mkdirSync(destDir, { recursive: true });
  for (const f of present) copyFileSync(f, join(destDir, basename(f)));
  writeFileSync(join(destDir, ".digest"), digest + "\n", "utf-8");
  return destDir;
}

// Snapshot every machine folder's three JSONs plus the root reports, skipping
// anything byte-identical to the previous snapshot. One stamp per run.
export function archiveSnapshots(tokenUsageDir, stamp = archiveStamp()) {
  const out = [];
  const archiveRoot = join(tokenUsageDir, "archive");
  for (const dir of machineFolders(tokenUsageDir)) {
    const files = ["totals.json", "sessions.json", "hardware.json"]
      .map((n) => findGenerated(dir, n))
      .filter(Boolean);
    if (snap(files, join(archiveRoot, basename(dir), stamp))) {
      out.push(`archive/${basename(dir)}/${stamp}`);
    }
  }
  const reports = ["BY-COMPUTER.md", "BY-ACCOUNT.md", "BY-COMPANY.md",
                   "STATS.md", "LIFETIME.md", "ALL-COMPUTERS.json"]
    .map((n) => findGenerated(tokenUsageDir, n))
    .filter(Boolean);
  if (snap(reports, join(archiveRoot, "reports", stamp))) {
    out.push(`archive/reports/${stamp}`);
  }
  return out;
}

// Metadata-first scanners for local AI-coding session logs.
// Sources: Claude Code (~/.claude/projects), Cowork (local-agent-mode-sessions),
// Codex (~/.codex/sessions). Multi-root: every scanner takes a list of home
// roots so logs synced from other machines/accounts merge into one profile.
import {
  createReadStream,
  existsSync,
  readdirSync,
  statSync,
  realpathSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets, maskPath, projectLabel } from "./redact.mjs";

const MAX_ACTIVE_GAP_MIN = 15;

export function emptyStats() {
  return {
    sessions: new Map(), // sessionId -> {firstTs,lastTs,minutes:Set,project,models:Map,tok:{in,out,cr,cw}}
    toolCounts: new Map(),
    filePaths: new Set(), // masked
    hourCounts: new Array(24).fill(0),
    activeDays: new Set(),
    weekendEvents: 0,
    totalEvents: 0,
    userTurns: 0,
    seenMessageIds: new Set(),
  };
}

// ---- source discovery ------------------------------------------------------

export function discoverSources(roots) {
  const found = [];
  for (const root of roots) {
    const claudeBase = join(root, ".claude", "projects");
    if (existsSync(claudeBase)) {
      for (const f of listJsonl(claudeBase, 2))
        found.push({ source: "claude_code", root, path: f });
    }
    const coworkBase = join(
      root,
      "Library",
      "Application Support",
      "Claude",
      "local-agent-mode-sessions"
    );
    if (existsSync(coworkBase)) {
      for (const f of listJsonl(coworkBase, 7))
        found.push({ source: "cowork", root, path: f });
    }
    const codexBase = join(root, ".codex", "sessions");
    if (existsSync(codexBase)) {
      for (const f of listJsonl(codexBase, 5))
        found.push({ source: "codex", root, path: f });
    }
  }
  return dedupeByRealpath(found);
}

function listJsonl(base, maxDepth) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (entry.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(base, 0);
  return out;
}

function dedupeByRealpath(files) {
  const seen = new Set();
  const out = [];
  for (const f of files) {
    let real;
    try {
      real = realpathSync(f.path);
    } catch {
      real = f.path;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(f);
  }
  return out;
}

// ---- streaming parse -------------------------------------------------------

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

function session(stats, id, ts) {
  let s = stats.sessions.get(id);
  if (!s) {
    s = {
      firstTs: ts,
      lastTs: ts,
      minutes: new Set(),
      project: null,
      models: new Map(),
      tok: { in: 0, out: 0, cr: 0, cw: 0 },
      // Per-session copies of the quantities the five axes are computed from.
      // The global totals alone cannot give a single month its own star, and a
      // star per month is the whole point of the snapshot timeline.
      tools: 0,
      exts: new Map(),
      hours: new Array(24).fill(0),
      days: new Set(),
    };
    stats.sessions.set(id, s);
  }
  if (ts < s.firstTs) s.firstTs = ts;
  if (ts > s.lastTs) s.lastTs = ts;
  s.minutes.add(Math.floor(ts / 60000));
  const d = new Date(ts);
  if (!isNaN(d.getTime())) {
    s.hours[d.getHours()] += 1;
    s.days.add(d.toISOString().slice(0, 10));
  }
  return s;
}

function temporal(stats, ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return;
  stats.totalEvents += 1;
  stats.hourCounts[d.getHours()] += 1;
  const day = d.getDay();
  if (day === 0 || day === 6) stats.weekendEvents += 1;
  stats.activeDays.add(d.toISOString().slice(0, 10));
}

// Claude Code + Cowork share the transcript format.
export async function parseClaudeFile(filePath, stats, opts = {}) {
  let sessionId = filePath.split("/").pop().replace(/\.jsonl$/, "");
  await streamLines(filePath, (line) => {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    const ts = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
    if (isNaN(ts)) return;
    if (typeof d.sessionId === "string") sessionId = d.sessionId;
    temporal(stats, ts);
    const s = session(stats, sessionId, ts);
    if (typeof d.cwd === "string" && !s.project) {
      const label = projectLabel(d.cwd);
      if (label && !opts.excluded?.(d.cwd)) s.project = label;
      else if (opts.excluded?.(d.cwd)) s.project = "[excluded]";
    }
    const msg = d.message;
    if (d.type === "user" && msg && typeof msg.content === "string") {
      stats.userTurns += 1;
    } else if (d.type === "assistant" && msg) {
      const model = typeof msg.model === "string" ? msg.model : null;
      if (model && !model.startsWith("<") && !model.includes("synthetic"))
        s.models.set(model, (s.models.get(model) ?? 0) + 1);
      const u = msg.usage;
      const id = typeof msg.id === "string" ? msg.id : null;
      if (u && !(id && stats.seenMessageIds.has(id))) {
        if (id) stats.seenMessageIds.add(id);
        s.tok.in += u.input_tokens ?? 0;
        s.tok.out += u.output_tokens ?? 0;
        s.tok.cr += u.cache_read_input_tokens ?? 0;
        s.tok.cw += u.cache_creation_input_tokens ?? 0;
      }
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item?.type === "tool_use") {
            if (item.name)
              stats.toolCounts.set(
                item.name,
                (stats.toolCounts.get(item.name) || 0) + 1
              );
            s.tools += 1;
            const input = item.input;
            for (const key of ["file_path", "path", "notebook_path"]) {
              const p = input?.[key];
              if (typeof p === "string") {
                if (opts.excluded?.(p)) continue;
                if (stats.filePaths.size < 5000) stats.filePaths.add(maskPath(p));
                // Only the extension, never the path: a month bucket has to be
                // safe to sync, and an extension is not a filename.
                const ext = extOf(p);
                if (ext) s.exts.set(ext, (s.exts.get(ext) ?? 0) + 1);
              }
            }
          }
        }
      }
    }
  });
}

export async function parseCodexFile(filePath, stats, opts = {}) {
  let sessionId = filePath.split("/").pop();
  let model = null;
  await streamLines(filePath, (line) => {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    const ts = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
    if (isNaN(ts)) return;
    const payload = d.payload;
    if (d.type === "session_meta" && payload) {
      if (typeof payload.id === "string") sessionId = payload.id;
      if (typeof payload.model === "string") model = payload.model;
    }
    temporal(stats, ts);
    const s = session(stats, sessionId, ts);
    if (d.type === "session_meta" && typeof payload?.cwd === "string" && !s.project) {
      s.project = opts.excluded?.(payload.cwd) ? "[excluded]" : projectLabel(payload.cwd);
    }
    if (d.type === "event_msg" && payload?.info?.total_token_usage) {
      const t = payload.info.total_token_usage;
      const cached = t.cached_input_tokens ?? 0;
      s.tok.in = Math.max(0, (t.input_tokens ?? 0) - cached);
      s.tok.out = t.output_tokens ?? s.tok.out;
      s.tok.cr = cached;
      if (model) s.models.set(model, (s.models.get(model) ?? 0) + 1);
    } else if (d.type === "response_item" && payload) {
      if (payload.type === "function_call" || payload.type === "local_shell_call") {
        const name = payload.name || "shell";
        stats.toolCounts.set(name, (stats.toolCounts.get(name) || 0) + 1);
        s.tools += 1;
      } else if (payload.role === "user") {
        stats.userTurns += 1;
      }
    }
  });
}

// ---- finalize --------------------------------------------------------------

export function activeDurationMs(minutes) {
  const sorted = [...minutes].sort((a, b) => a - b).map((m) => m * 60000);
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return 60000;
  const maxGap = MAX_ACTIVE_GAP_MIN * 60000;
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0) total += Math.min(gap, maxGap);
  }
  return total;
}

export function finalize(stats) {
  const sessions = [...stats.sessions.entries()];
  let durationMs = 0;
  let totIn = 0, totOut = 0, totCr = 0, totCw = 0;
  const projects = new Map();
  const models = new Map();
  const monthly = new Map();
  for (const [, s] of sessions) {
    const dur = activeDurationMs(s.minutes);
    durationMs += dur;
    totIn += s.tok.in;
    totOut += s.tok.out;
    totCr += s.tok.cr;
    totCw += s.tok.cw;
    if (s.project) projects.set(s.project, (projects.get(s.project) || 0) + 1);
    for (const [m, n] of s.models) models.set(m, (models.get(m) ?? 0) + n);
    if (isFinite(s.firstTs)) {
      const key = new Date(s.firstTs).toISOString().slice(0, 7);
      const b = monthly.get(key) ?? {
        sessions: 0, durationMs: 0, in: 0, out: 0, cache: 0,
        tools: 0,
        exts: new Map(),
        models: new Map(),
        projects: new Set(),
        hours: new Array(24).fill(0),
        days: new Set(),
      };
      b.sessions += 1;
      b.durationMs += dur;
      b.in += s.tok.in;
      b.out += s.tok.out;
      b.cache += s.tok.cr + s.tok.cw;
      // A session is attributed whole to the month it STARTED in — the same
      // rule the stats page states for days ("sessions past midnight count
      // entirely toward their start date"). Splitting a session across a month
      // boundary here would make the two numbers disagree.
      b.tools += s.tools;
      for (const [e, n] of s.exts) b.exts.set(e, (b.exts.get(e) ?? 0) + n);
      for (const [m, n] of s.models) b.models.set(m, (b.models.get(m) ?? 0) + n);
      if (s.project && s.project !== "[excluded]") b.projects.add(s.project);
      for (let h = 0; h < 24; h++) b.hours[h] += s.hours[h];
      for (const d of s.days) b.days.add(d);
      monthly.set(key, b);
    }
  }
  const streaks = computeStreaks(stats.activeDays);
  return {
    total_sessions: stats.sessions.size,
    active_days: stats.activeDays.size,
    total_duration_hours: +(durationMs / 3.6e6).toFixed(1),
    total_input_tokens: totIn,
    total_output_tokens: totOut,
    total_cache_read_tokens: totCr,
    total_cache_write_tokens: totCw,
    user_turns: stats.userTurns,
    tool_call_counts: Object.fromEntries(
      [...stats.toolCounts.entries()].sort((a, b) => b[1] - a[1])
    ),
    projects: [...projects.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => ({ name, sessions: count })),
    models: Object.fromEntries(
      [...models.entries()].sort((a, b) => b[1] - a[1])
    ),
    file_paths_touched: stats.filePaths.size,
    languages: inferLanguages(stats.filePaths),
    hour_buckets: stats.hourCounts.slice(),
    weekend_ratio:
      stats.totalEvents > 0
        ? +(stats.weekendEvents / stats.totalEvents).toFixed(2)
        : 0,
    longest_streak_days: streaks.longest,
    current_streak_days: streaks.current,
    monthly_buckets: [...monthly.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, b]) => ({
        month,
        sessions: b.sessions,
        duration_hours: +(b.durationMs / 3.6e6).toFixed(1),
        input_tokens: b.in,
        output_tokens: b.out,
        cache_tokens: b.cache,
        // Axis inputs, so this month can draw its own star with no reference to
        // any other month and without carrying a project name or a file path.
        tool_calls: b.tools,
        languages: langsFromExts(b.exts),
        projects_count: b.projects.size,
        models: Object.fromEntries([...b.models.entries()].sort((x, y) => y[1] - x[1])),
        hour_buckets: b.hours,
        active_days: b.days.size,
        longest_streak_days: computeStreaks(b.days).longest,
      })),
  };
}

const EXT_TO_LANG = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift", rb: "ruby", php: "php",
  cpp: "cpp", cc: "cpp", h: "c", c: "c", cs: "csharp", sh: "shell",
  bash: "shell", zsh: "shell", sql: "sql", sol: "solidity", yaml: "yaml",
  yml: "yaml", json: "json", md: "markdown", css: "css", vue: "vue",
  svelte: "svelte", dart: "dart", lua: "lua", r: "r", ex: "elixir",
};
const GENERATED_RE =
  /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.next|\.cache)(\/|$)|package-lock\.json$/i;

// The extension alone, lowercased, and only when it maps to a language we
// name. Returns null for generated/vendored paths so a month's language count
// is not inflated by node_modules.
export function extOf(p) {
  if (typeof p !== "string" || GENERATED_RE.test(p)) return null;
  const base = p.toLowerCase().split("/").pop() ?? "";
  if (!base.includes(".")) return null;
  const ext = base.split(".").pop();
  return EXT_TO_LANG[ext] ? ext : null;
}

function langsFromExts(exts) {
  const langs = {};
  for (const [ext, n] of exts) {
    const lang = EXT_TO_LANG[ext];
    if (lang) langs[lang] = (langs[lang] || 0) + n;
  }
  return Object.fromEntries(Object.entries(langs).sort((a, b) => b[1] - a[1]));
}

function inferLanguages(filePaths) {
  const langs = {};
  for (const p of filePaths) {
    if (GENERATED_RE.test(p)) continue;
    const ext = p.toLowerCase().split(".").pop();
    const lang = EXT_TO_LANG[ext];
    if (lang) langs[lang] = (langs[lang] || 0) + 1;
  }
  return langs;
}

function computeStreaks(activeDays) {
  if (activeDays.size === 0) return { longest: 0, current: 0 };
  const sorted = [...activeDays].sort();
  const dayMs = 864e5;
  let longest = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const diff = Math.round(
      (Date.parse(sorted[i]) - Date.parse(sorted[i - 1])) / dayMs
    );
    if (diff === 1) {
      run += 1;
      if (run > longest) longest = run;
    } else if (diff > 1) run = 1;
  }
  let current = 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    const diff = Math.round(
      (Date.parse(sorted[i]) - Date.parse(sorted[i - 1])) / dayMs
    );
    if (diff === 1) current += 1;
    else break;
  }
  const daysSinceLast = Math.round(
    (Date.parse(new Date().toISOString().slice(0, 10)) -
      Date.parse(sorted[sorted.length - 1])) /
      dayMs
  );
  if (daysSinceLast > 1) current = 0;
  return { longest, current };
}

export function defaultRoots() {
  return [homedir()];
}

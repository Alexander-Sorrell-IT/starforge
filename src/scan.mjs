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
import { redactSecrets, maskPath, projectLabel, projectPseudonym } from "./redact.mjs";

// "Which day was that?" and "what hour was that?" have to be answered on the
// SAME clock. They were not: hours came from getHours() (local) while day keys
// came from toISOString() (UTC), so a 4pm-to-7pm session in a US timezone was
// filed under two different UTC dates while its hour buckets said 16:00 and
// 20:00 — no midnight in sight, two active days, and an inflated streak on the
// axis the design leans on being hard to inflate. It also made the whole star a
// function of $TZ: the same log scored OUTSIDE THE BOX 2.3 under UTC and 1.0
// under America/Chicago. A day is a local calendar concept, which is also what
// the hour histogram already assumed, so both now use local time.
export function localDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Model ids are the ONE string copied out of a log that survives into a monthly
// snapshot, and snapshots are the file this tool tells you is safe to sync. In
// a real Claude Code / Codex transcript `model` is an api id like
// "claude-opus-5". Nothing guarantees that: the field is whatever the log says,
// and --roots deliberately points the scanner at other people's home
// directories. So it is shape-checked before it is ever stored — a value that
// does not look like a model id is replaced by a stable pseudonym, which keeps
// the DISTINCT-model count honest without carrying the string itself.
// No "@" and no "/": those are what an email address and a relative path look
// like, and both sailed through an earlier version of this shape. maskPath only
// rewrites paths under a home directory, so "Projects/SecretClient" would have
// survived. Real model ids from Claude Code and Codex are letters, digits, dots,
// colons and dashes; an "org/model"-style id becomes a pseudonym instead, which
// costs a display name and keeps the distinct-model COUNT exactly right.
const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export function sanitizeModel(model) {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  // redactSecrets first: a key-shaped substring must never reach the shape test
  // and get waved through because it happens to be short and token-like.
  const cleaned = maskPath(redactSecrets(trimmed));
  if (cleaned !== trimmed || !MODEL_SHAPE.test(cleaned)) return projectPseudonym(trimmed);
  return cleaned;
}

const MAX_ACTIVE_GAP_MIN = 15;

// Count DESC, then key ASC. The second term is the whole point: `b[1]-a[1]`
// alone leaves ties in insertion order, and insertion order came from the
// filesystem — so two machines with the same corpus could disagree about which
// of three equally-used tools is listed first. A total order has no ties left
// to break, so the output is a function of the DATA and nothing else.
export function byCountThenKey(a, b) {
  return b[1] - a[1] || String(a[0]).localeCompare(String(b[0]));
}

export function emptyStats() {
  return {
    sessions: new Map(), // sessionId -> {firstTs,lastTs,minutes:Set,project,models:Map,tok:{in,out,cr,cw}}
    toolCounts: new Map(),
    filePaths: new Set(), // masked, CAPPED at 5000 — a memory bound, not a tally
    filePathTotal: 0, // every path seen, so the cap cannot understate the count
    langCounts: new Map(), // accumulated per path as it arrives, so the cap cannot hide a language
    hourCounts: new Array(24).fill(0),
    nightMinutes: new Set(), // distinct minutes in 00:00-05:59, i.e. real hours

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
      // SORTED. readdirSync returns filesystem order, which differs between
      // machines, between filesystems, and after a file is rewritten — so an
      // unsorted walk made the scan order an input the user cannot see.
      //
      // Order does not change any TOTAL (a sum is a sum), but it does decide:
      //   - which cwd wins a session's project label, since the first one seen
      //     is kept and later ones ignored
      //   - how ties break in every `sort((a,b) => b[1]-a[1])` below, because
      //     V8's sort is stable and therefore falls back to insertion order
      //
      // Two machines holding an identical corpus could publish different
      // reports, which is fatal for a tool whose whole argument is "check it
      // yourself". Same bytes in, same bytes out.
      entries = readdirSync(dir).sort();
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
    s.days.add(localDayKey(d));
  }
  return s;
}

function temporal(stats, ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return;
  stats.totalEvents += 1;
  stats.hourCounts[d.getHours()] += 1;
  // Distinct night MINUTES, so OUTSIDE THE BOX can be scored in hours.
  // hourCounts is a per-EVENT tally, and computeLevels was reading
  // `buckets.slice(0,6)` as if it were hours: lg(nightHours, 60) is calibrated
  // to saturate at 600 hours (~25 solid nights) but was saturating at 600 log
  // LINES, which is about two late sessions. Measured: 5 sessions inside one
  // single night, active_days 1, scored the axis a full 5.0.
  //
  // A minute is the unit the session tracker already uses for real elapsed
  // time, and de-duplicating it means a chattier tool loop cannot buy a longer
  // arm than a quieter one doing the same work.
  if (d.getHours() < 6) stats.nightMinutes.add(Math.floor(ts / 60000));
  const day = d.getDay();
  if (day === 0 || day === 6) stats.weekendEvents += 1;
  stats.activeDays.add(localDayKey(d));
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
      const raw = typeof msg.model === "string" ? msg.model : null;
      const model =
        raw && !raw.startsWith("<") && !raw.includes("synthetic")
          ? sanitizeModel(raw)
          : null;
      if (model) s.models.set(model, (s.models.get(model) ?? 0) + 1);
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
            // A tool NAME is attacker-supplied text, not an identifier from a
            // fixed vocabulary: MCP servers name their own tools, and anything
            // that constructs one from a variable can put a credential in it.
            // Unredacted, these keys went straight into `tool_call_counts` in
            // reports/expanded-*.json — a live sk-ant key and a full JWT,
            // verbatim, in the same file where profile.mjs's `tool_mix` had
            // already rendered the identical strings as "[redacted]".
            //
            // sanitizeModel, not redactSecrets: the model field two fields over
            // solved this exact problem properly — redact, then shape-check,
            // then pseudonymise whatever fails — and a name that survives
            // redaction but still looks like a path or an address is no more
            // publishable than the key was.
            if (item.name) {
              const tool = sanitizeModel(item.name);
              if (tool)
                stats.toolCounts.set(tool, (stats.toolCounts.get(tool) || 0) + 1);
            }
            s.tools += 1;
            const input = item.input;
            for (const key of ["file_path", "path", "notebook_path"]) {
              const p = input?.[key];
              if (typeof p === "string") {
                if (opts.excluded?.(p)) continue;
                // The 5,000-path cap bounds MEMORY, which is legitimate — but
                // the same Set was the only input to inferLanguages(), so on a
                // large history the language list was whatever happened to be
                // touched first. Measured on a real corpus: capped gave 12
                // languages and a total of 23.9; uncapped gave 14 (sql and
                // swift were simply never reached) and 24.1. A published score
                // was wrong by 0.2 because of a memory guard nobody connected
                // to scoring.
                //
                // Languages are now counted as each path ARRIVES, so the tally
                // is complete however small the cap gets, and the cap goes back
                // to doing only its own job. `filePathTotal` keeps the true
                // count, because `filePaths.size` stops being one at 5,000.
                stats.filePathTotal += 1;
                const masked = maskPath(p);
                if (stats.filePaths.size < 5000) stats.filePaths.add(masked);
                countLanguage(stats.langCounts, masked);
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
      if (typeof payload.model === "string") model = sanitizeModel(payload.model);
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

// A month bucket, created on demand. Two things create one: a session that
// STARTED in that month, and a calendar day belonging to it that a neighbouring
// month's session ran through. The second case can produce a month with active
// days but no sessions — that is honest (activity did occur then) and every
// consumer treats the numeric fields as counts that may be zero.
function ensureMonth(monthly, key) {
  let b = monthly.get(key);
  if (!b) {
    b = {
      sessions: 0, durationMs: 0, in: 0, out: 0, cache: 0,
      tools: 0,
      exts: new Map(),
      models: new Map(),
      projects: new Set(),
      hours: new Array(24).fill(0),
      days: new Set(),
    };
    monthly.set(key, b);
  }
  return b;
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
      // Local clock here too: the month a session belongs to must agree with the
      // day keys it contributes, or a session started late on the last day of a
      // month lands in the wrong bucket from its own days.
      const key = localDayKey(new Date(s.firstTs)).slice(0, 7);
      const b = ensureMonth(monthly, key);
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
      // Calendar facts are NOT attributed to the start month the way volume is.
      // A session that runs 31 Jan into 1 Feb really did happen on a February
      // day, and filing that day under January produced counts that are false on
      // their face — a 31-day month reporting 32 active days, and 1 Feb counted
      // in both months once February had a session of its own. Volume (tokens,
      // tool calls, sessions) still goes whole to the start month, which is the
      // documented rule; a DAY goes to the month that day is actually in.
      for (const day of s.days) {
        const dayMonth = day.slice(0, 7);
        if (dayMonth === key) b.days.add(day);
        else {
          const other = ensureMonth(monthly, dayMonth);
          other.days.add(day);
        }
      }
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
      [...stats.toolCounts.entries()].sort(byCountThenKey)
    ),
    // `projects` is the TOP 20 for display. `projects_count` is how many there
    // actually are, and it is emitted separately because computeLevels falls
    // back to `(agg.projects ?? []).length` — so the slice, a presentation
    // decision, was silently capping the ENGINEERING axis at lg(20,4)*0.6 =
    // 2.46 no matter how many repositories a person worked in. Measured: 400
    // project directories and 20 produced byte-identical stars.
    //
    // It also made the two views disagree with each other. Monthly snapshots
    // set `projects_count: b.projects.size` with no cap, so one month could
    // report 355 projects while the all-time report said 20 — and a single
    // month drew a LONGER engineering arm than the entire history containing
    // it. A number used for scoring must never be the same number that was
    // shortened to fit on a screen.
    projects: [...projects.entries()]
      .sort(byCountThenKey)
      .slice(0, 20)
      .map(([name, count]) => ({ name, sessions: count })),
    projects_count: projects.size,
    models: Object.fromEntries(
      [...models.entries()].sort(byCountThenKey)
    ),
    // Both derived from the uncapped tallies now. `filePaths.size` stops
    // counting at 5,000 and `inferLanguages(filePaths)` stopped LEARNING there.
    file_paths_touched: stats.filePathTotal || stats.filePaths.size,
    languages: stats.langCounts?.size
      ? Object.fromEntries(stats.langCounts)
      : inferLanguages(stats.filePaths),
    hour_buckets: stats.hourCounts.slice(),
    night_hours: +((stats.nightMinutes?.size ?? 0) / 60).toFixed(1),
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

// __proto__: null because these lookups are keyed by an attacker-influenced
// filename extension. On a plain object literal, a file called `a.constructor`
// made `EXT_TO_LANG[ext]` truthy via the prototype chain and put the literal
// string "function Object() { [native code] }" into the language list — junk in
// a synced snapshot, and a free +1 to the distinct-language count that feeds the
// ENGINEERING arm.
const EXT_TO_LANG = {
  __proto__: null,
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
  return Object.fromEntries(Object.entries(langs).sort(byCountThenKey));
}

// One masked path -> at most one language tick. Split out of inferLanguages so
// it can be called as each path arrives, which is what lets the 5,000-path
// memory cap stop deciding which languages a person knows.
export function countLanguage(langCounts, maskedPath) {
  if (GENERATED_RE.test(maskedPath)) return;
  const ext = maskedPath.toLowerCase().split(".").pop();
  const lang = EXT_TO_LANG[ext];
  if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
}

function inferLanguages(filePaths) {
  const langs = new Map();
  for (const p of filePaths) countLanguage(langs, p);
  return Object.fromEntries(langs);
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

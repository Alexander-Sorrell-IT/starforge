// Judgment-signal profile: the aggregate metrics Standout's server-side AI
// consumes (correction rate, question ratio, prompt depth, delegation, tool
// mix, concurrency, proficiency dimensions) — computed 100% locally.
//
// PRIVACY CONTRACT (hard invariants):
//   1. No network I/O anywhere in this module.
//   2. Prompt TEXT is read in-stream only to increment counters — never stored.
//      No exchanges, no prompt_samples, no prompt_frequency, no
//      conversation_samples (exactly the fields Standout uploads).
//   3. Everything returned is counts/ratios/labels; strings pass through
//      projectLabel/maskPath/redactSecrets before landing in any object.
//
// Metric lineage: standout bundle (payload/ai-usage/aggregate sections) for
// formulas + regexes (ported verbatim), the Python token-usage system
// (stats.py / fun_stats.py / stats_page.py) for streak semantics, records,
// day attribution, and the four-counter token split. The Python code is the
// authoritative spec where the two disagree (e.g. current-streak).
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { redactSecrets, maskPath, projectLabel } from "./redact.mjs";
// Imported rather than reimplemented. profile.mjs and scan.mjs read the SAME
// field out of the SAME file, and every divergence between them has been a bug:
// the local-clock day key landed in scan.mjs only, and so did the model shape
// check — so one generated report carried `"models": {"proj-<hash>": 3}` from
// scan.mjs next to `"model_sessions": {"/home/<person>/private/models": 6}`
// from here, and the raw path went on to the HTML page. A second copy of a
// redaction rule is a rule that will be fixed once.
import { sanitizeModel, localDayKey } from "./scan.mjs";

const MAX_ACTIVE_GAP_MIN = 15;
const MIN_PROMPT_CHARS = 16; // Standout's low-signal floor
const MAX_LANG_PATHS = 5000;

// Ported verbatim from standout ai-usage/cursor.ts (CORRECTION_RE).
export const CORRECTION_RE =
  /\b(no|nope|actually|wrong|incorrect|instead|revert|undo|don'?t|stop|not what|that'?s not)\b/i;

// Ported verbatim from standout wrapped/aggregate.ts (RETAIL_RATES, $/Mtok).
export const RETAIL_RATES = [
  { match: /claude.*opus/i, input: 7.5, output: 37.5, cacheRead: 0.75, cacheWrite: 9.375 },
  { match: /claude.*sonnet/i, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /claude.*haiku/i, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { match: /gpt-?5(-mini|-nano)?/i, input: 7.5, output: 37.5, cacheRead: 0.75, cacheWrite: 9.375 },
  { match: /gpt-?4/i, input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 2.5 },
];

export function rateForModel(model) {
  if (model) {
    for (const r of RETAIL_RATES) {
      if (r.match.test(model))
        return { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite };
    }
  }
  return { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
}

// Ported verbatim from standout wrapped/aggregate.ts (classifyProvider).
export function classifyProvider(model) {
  const m = String(model ?? "").toLowerCase();
  if (m.startsWith("claude") || m.includes("anthropic")) return "anthropic";
  if (m.startsWith("gpt") || m.includes("openai") || m.startsWith("o1") || m.startsWith("o3"))
    return "openai";
  return "other";
}

export const SOURCE_LABELS = {
  claude_code: "Claude Code",
  cowork: "Cowork",
  codex: "Codex",
};

// Cowork = knowledge work: excluded from languages/craft, kept in rhythm/cadence.
const CODE_SOURCES = new Set(["claude_code", "codex"]);
const HANDS_ON_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const OPERATOR_TOOLS = new Set(["Bash", "shell", "local_shell_call", "exec_command"]);

// Kept in sync with scan.mjs (which does not export these).
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

// ---- signal collection (second streaming pass; counting only) --------------

function emptyCollector() {
  return {
    perSource: new Map(), // source -> mutable counters
    sessions: new Map(),  // sessionId -> {source, firstTs, lastTs, minutes:Set, models:Map, tok, turns, project}
    seenMessageIds: new Set(),
    activeDays: new Set(),
    hourCounts: new Array(24).fill(0),
    weekendEvents: 0,
    totalEvents: 0,
  };
}

function sourceBucket(col, source) {
  let b = col.perSource.get(source);
  if (!b) {
    b = {
      files: 0, prompt_turns: 0, prompt_chars_total: 0, question_turns: 0,
      correction_turns: 0, tool_calls: 0, toolCounts: new Map(),
      langPaths: new Set(), firstTs: Infinity, lastTs: -Infinity,
    };
    col.perSource.set(source, b);
  }
  return b;
}

function touchSession(col, id, source, ts) {
  let s = col.sessions.get(id);
  if (!s) {
    s = {
      source, firstTs: ts, lastTs: ts, minutes: new Set(),
      models: new Map(), tok: { in: 0, out: 0, cr: 0, cw: 0 },
      turns: 0, project: null,
    };
    col.sessions.set(id, s);
  }
  if (ts < s.firstTs) s.firstTs = ts;
  if (ts > s.lastTs) s.lastTs = ts;
  s.minutes.add(Math.floor(ts / 60000));
  return s;
}

function temporal(col, src, ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return;
  col.totalEvents += 1;
  col.hourCounts[d.getHours()] += 1;
  const day = d.getDay();
  if (day === 0 || day === 6) col.weekendEvents += 1;
  // LOCAL, matching the hour histogram two lines up. This file read hours on
  // the local clock and days on the UTC one, so an evening session in a
  // US timezone crossed midnight in UTC and was filed as TWO active days: a
  // Chicago user working 10:00 and 20:00 on one day got active_days 2 and a
  // 2-day streak here, while scan.mjs — reading the same events — said 1 and 1.
  // One generated report, two answers, and the inflated one fed
  // proficiency.consistency, the axis that is meant to be hardest to inflate.
  //
  // scan.mjs fixed this months ago and the README says so in the past tense.
  // The fix never crossed into this file because this file is a second copy of
  // that logic — so it imports the helper now instead of owning a third.
  col.activeDays.add(localDayKey(d));
  if (ts < src.firstTs) src.firstTs = ts;
  if (ts > src.lastTs) src.lastTs = ts;
}

// Standout's low-signal filter: strip nothing, skip injected/command wrappers
// ('<' prefix), slash commands, and sub-16-char turns. Text is counted, then
// dropped — it never reaches the returned object.
function countPromptTurn(src, text) {
  const t = text.trim();
  if (!t || t.startsWith("<") || t.startsWith("/") || t.length < MIN_PROMPT_CHARS) return;
  src.prompt_turns += 1;
  src.prompt_chars_total += t.length;
  if (t.includes("?")) src.question_turns += 1;
  if (CORRECTION_RE.test(t)) src.correction_turns += 1;
}

function countTool(src, name) {
  if (!name) return;
  src.tool_calls += 1;
  src.toolCounts.set(name, (src.toolCounts.get(name) || 0) + 1);
}

function countLangPath(src, p, excluded) {
  if (typeof p !== "string" || src.langPaths.size >= MAX_LANG_PATHS) return;
  if (excluded?.(p)) return;
  src.langPaths.add(maskPath(p));
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

async function collectClaudeFile(filePath, source, col, opts) {
  const src = sourceBucket(col, source);
  src.files += 1;
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
    temporal(col, src, ts);
    const s = touchSession(col, sessionId, source, ts);
    if (typeof d.cwd === "string" && !s.project) {
      s.project = opts.excluded?.(d.cwd) ? "[excluded]" : projectLabel(d.cwd);
    }
    const msg = d.message;
    if (d.type === "user" && msg && typeof msg.content === "string") {
      s.turns += 1;
      countPromptTurn(src, msg.content);
    } else if (d.type === "assistant" && msg) {
      // Sanitised at CAPTURE, not at emit. The old code stored the raw string
      // and redacted only on the way into one field, so `models.model_sessions`
      // and the HTML page both received "/home/<person>/private/models"
      // verbatim — redactSecrets matches no path and no email, and there was no
      // shape check. sanitizeModel redacts, then tests the shape, then
      // pseudonymises anything that fails, so a value that is not a model id
      // cannot reach ANY consumer downstream of here.
      const model = sanitizeModel(msg.model);
      if (model && !model.startsWith("<") && !model.includes("synthetic"))
        s.models.set(model, (s.models.get(model) ?? 0) + 1);
      const u = msg.usage;
      const id = typeof msg.id === "string" ? msg.id : null;
      if (u && !(id && col.seenMessageIds.has(id))) {
        if (id) col.seenMessageIds.add(id);
        s.tok.in += u.input_tokens ?? 0;
        s.tok.out += u.output_tokens ?? 0;
        s.tok.cr += u.cache_read_input_tokens ?? 0;
        s.tok.cw += u.cache_creation_input_tokens ?? 0;
      }
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item?.type === "tool_use") {
            countTool(src, item.name);
            for (const key of ["file_path", "path", "notebook_path"])
              countLangPath(src, item.input?.[key], opts.excluded);
          }
        }
      }
    }
  });
}

async function collectCodexFile(filePath, col, opts) {
  const src = sourceBucket(col, "codex");
  src.files += 1;
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
      // Codex's session_meta carries the model too, and this assignment was the
      // second raw one. Sanitising only the Claude path would have left the
      // identical hole open for a different tool — which is how this class of
      // bug survives a fix in the first place.
      if (typeof payload.model === "string") model = sanitizeModel(payload.model);
    }
    temporal(col, src, ts);
    const s = touchSession(col, sessionId, "codex", ts);
    if (d.type === "session_meta" && typeof payload?.cwd === "string" && !s.project) {
      s.project = opts.excluded?.(payload.cwd) ? "[excluded]" : projectLabel(payload.cwd);
    }
    if (d.type === "event_msg" && payload?.info?.total_token_usage) {
      // Codex counters are cumulative per event: overwrite, never sum.
      const t = payload.info.total_token_usage;
      const cached = t.cached_input_tokens ?? 0;
      s.tok.in = Math.max(0, (t.input_tokens ?? 0) - cached);
      s.tok.out = t.output_tokens ?? s.tok.out;
      s.tok.cr = cached; // codex has no cache-write counter; cw stays 0
      if (model) s.models.set(model, (s.models.get(model) ?? 0) + 1);
    } else if (d.type === "response_item" && payload) {
      if (payload.type === "function_call" || payload.type === "local_shell_call") {
        countTool(src, payload.name || "shell");
      } else if (payload.role === "user") {
        s.turns += 1;
        const text =
          typeof payload.content === "string"
            ? payload.content
            : Array.isArray(payload.content)
            ? payload.content
                .map((c) => (typeof c?.text === "string" ? c.text : ""))
                .join("\n")
            : "";
        if (text) countPromptTurn(src, text);
      }
    }
  });
}

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

// files: [{source, path}] as returned by scan.mjs discoverSources (already
// realpath-deduped, so synced roots don't double-count the concurrency sweep).
// Returns aggregate-only signals: counters, ratios inputs, session intervals.
export async function collectProfileSignals(files, opts = {}) {
  const col = emptyCollector();
  for (const f of files ?? []) {
    try {
      if (f.source === "codex") await collectCodexFile(f.path, col, opts);
      else await collectClaudeFile(f.path, f.source ?? "claude_code", col, opts);
    } catch {
      // unreadable/missing file: skip, like the existing scanners
    }
  }
  const per_source = {};
  for (const [source, b] of col.perSource) {
    const languages = {};
    for (const p of b.langPaths) {
      if (GENERATED_RE.test(p)) continue;
      const lang = EXT_TO_LANG[p.toLowerCase().split(".").pop()];
      if (lang) languages[lang] = (languages[lang] || 0) + 1;
    }
    per_source[source] = {
      files: b.files,
      prompt_turns: b.prompt_turns,
      prompt_chars_total: b.prompt_chars_total,
      question_turns: b.question_turns,
      correction_turns: b.correction_turns,
      tool_calls: b.tool_calls,
      tool_counts: Object.fromEntries(
        [...b.toolCounts.entries()].sort((a, z) => z[1] - a[1])
      ),
      languages,
      first_ts: isFinite(b.firstTs) ? b.firstTs : null,
      last_ts: isFinite(b.lastTs) ? b.lastTs : null,
    };
  }
  const sessions = [];
  for (const [id, s] of col.sessions) {
    let model = null, best = 0;
    for (const [m, n] of s.models) if (n > best) { best = n; model = m; }
    sessions.push({
      id: redactSecrets(String(id)).slice(0, 8),
      source: s.source,
      project: s.project ? redactSecrets(s.project) : null,
      start_ts: s.firstTs,
      end_ts: s.lastTs,
      active_ms: activeDurationMs(s.minutes),
      turns: s.turns,
      tok: { ...s.tok },
      model: model ? redactSecrets(model) : null,
    });
  }
  sessions.sort((a, b) => a.start_ts - b.start_ts);
  return {
    generated_at: new Date().toISOString(),
    files_scanned: (files ?? []).length,
    per_source,
    sessions,
    active_days: [...col.activeDays].sort(),
    hour_counts: col.hourCounts,
    weekend_events: col.weekendEvents,
    total_events: col.totalEvents,
  };
}

// ---- metric computation (pure; synthetic-signal testable) ------------------

// Python zY9 semantics (stats.py streaks): current streak walks back from
// TODAY; any gap — including "was active yesterday but not today" — zeroes it.
// This deliberately overrides scan.mjs computeStreaks' leniency.
export function computeStreaks(activeDays, todayIso = null) {
  const days = [...new Set(activeDays ?? [])].sort();
  if (days.length === 0) return { current: 0, longest: 0 };
  const have = new Set(days);
  const today = todayIso ?? localDayKey(new Date());
  const dayMs = 864e5;
  let cur = 0;
  // LOCAL midnight, not Date.parse(). `Date.parse("2026-07-15")` returns UTC
  // midnight, and localDayKey then reads that instant back on the local clock —
  // which west of Greenwich is the PREVIOUS day. The walk started one day early
  // and never matched, so in every Americas timezone a user who was active
  // today scored current_streak 0, and a three-day run scored 2. UTC, Tokyo and
  // Auckland were all correct, which is exactly why it survived: the machine
  // that shows the bug is the machine most users are on, and not the one CI
  // runs in.
  //
  // This is the same mixed-clock mistake the comment on activeDays describes,
  // reintroduced two hundred lines away while fixing it — the parse stayed UTC
  // while the read became local. Both ends have to move together.
  const [ty, tm, td] = today.split("-").map(Number);
  let probe = new Date(ty, tm - 1, td).getTime();
  while (have.has(localDayKey(new Date(probe)))) {
    cur += 1;
    probe -= dayMs;
  }
  let longest = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = Math.round((Date.parse(days[i]) - Date.parse(days[i - 1])) / dayMs);
    if (diff === 1) {
      run += 1;
      if (run > longest) longest = run;
    } else if (diff > 1) run = 1;
  }
  return { current: cur, longest };
}

// Sweep-line over session intervals. juggle_pct = share of covered wall-clock
// with >=2 concurrent sessions; open_avg is time-weighted over covered time.
export function sweepConcurrency(sessions) {
  const events = [];
  for (const s of sessions ?? []) {
    if (!isFinite(s.start_ts) || !isFinite(s.end_ts)) continue;
    const end = Math.max(s.end_ts, s.start_ts + 60000);
    events.push([s.start_ts, 1], [end, -1]);
  }
  if (events.length === 0)
    return { open_peak: 0, open_avg: 0, juggle_pct: 0 };
  events.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let count = 0, prev = null, covered = 0, multi = 0, integral = 0, peak = 0;
  for (const [t, delta] of events) {
    if (prev !== null && count > 0) {
      const dt = t - prev;
      covered += dt;
      integral += count * dt;
      if (count >= 2) multi += dt;
    }
    count += delta;
    if (count > peak) peak = count;
    prev = t;
  }
  return {
    open_peak: peak,
    open_avg: covered > 0 ? +(integral / covered).toFixed(2) : 0,
    juggle_pct: covered > 0 ? +((multi / covered) * 100).toFixed(1) : 0,
  };
}

// Ported from standout wrapped/aggregate.ts computeToolRelationship, fed by
// monthly session counts per source derived from the signals session list.
export function computeToolRelationship(sessions) {
  const monthMap = new Map();
  for (const s of sessions ?? []) {
    if (!isFinite(s.start_ts)) continue;
    const month = new Date(s.start_ts).toISOString().slice(0, 7);
    let row = monthMap.get(month);
    if (!row) {
      row = new Map();
      monthMap.set(month, row);
    }
    row.set(s.source, (row.get(s.source) ?? 0) + 1);
  }
  const months = [...monthMap.keys()].sort();
  if (months.length < 2) {
    if (months.length === 1) {
      const row = monthMap.get(months[0]);
      const best = [...row.entries()].sort(([, a], [, b]) => b - a)[0];
      if (best) {
        return {
          kind: "loyalist",
          tool: SOURCE_LABELS[best[0]] ?? best[0],
          months_count: 1,
          sessions_count: best[1],
        };
      }
    }
    return { kind: "insufficient" };
  }
  const timeline = [];
  for (const month of months) {
    const row = monthMap.get(month);
    const total = [...row.values()].reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    const sorted = [...row.entries()].sort(([, a], [, b]) => b - a);
    const [topTool, topCount] = sorted[0];
    timeline.push({ month, dominant: topTool, share: topCount / total });
  }
  const dominants = timeline.map((t) => t.dominant);
  const lastDominant = dominants[dominants.length - 1];
  const firstDominant = dominants[0];
  if (firstDominant && lastDominant && firstDominant !== lastDominant) {
    let switchIdx = -1;
    for (let i = dominants.length - 1; i >= 1; i--) {
      if (dominants[i] === lastDominant && dominants[i - 1] !== lastDominant) {
        switchIdx = i;
        break;
      }
    }
    if (switchIdx > 0) {
      return {
        kind: "switch",
        from_tool: SOURCE_LABELS[firstDominant] ?? firstDominant,
        to_tool: SOURCE_LABELS[lastDominant] ?? lastDominant,
        switch_month: timeline[switchIdx].month,
        timeline: timeline.map((t) => ({
          month: t.month,
          dominant: SOURCE_LABELS[t.dominant] ?? t.dominant,
          share: +t.share.toFixed(2),
        })),
      };
    }
  }
  if (new Set(dominants).size === 1) {
    let totalSessions = 0;
    for (const row of monthMap.values()) totalSessions += row.get(firstDominant) ?? 0;
    return {
      kind: "loyalist",
      tool: SOURCE_LABELS[firstDominant] ?? firstDominant,
      months_count: months.length,
      sessions_count: totalSessions,
    };
  }
  const totalsByTool = new Map();
  for (const row of monthMap.values())
    for (const [tool, n] of row) totalsByTool.set(tool, (totalsByTool.get(tool) ?? 0) + n);
  const grandTotal = [...totalsByTool.values()].reduce((a, b) => a + b, 0);
  const tools = [...totalsByTool.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([tool, n]) => ({
      tool: SOURCE_LABELS[tool] ?? tool,
      share: grandTotal > 0 ? +(n / grandTotal).toFixed(2) : 0,
    }));
  return { kind: "polyglot", tools };
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const clamp5 = (v) => Math.min(5, Math.max(0, v));
const lg = (v, mid) => 5 * (Math.log1p(Math.max(v, 0)) / Math.log1p(mid * 10));

// rawSignals: the object collectProfileSignals returns. opts.now (ms) makes
// time-relative metrics (streaks, 30d intensity) deterministic in tests.
export function computeProfile(rawSignals, opts = {}) {
  const sig = rawSignals ?? {};
  const now = opts.now ?? Date.now();
  const todayIso = localDayKey(new Date(now));
  const perSource = sig.per_source ?? {};
  const sessions = Array.isArray(sig.sessions) ? sig.sessions : [];
  const sources = Object.keys(perSource);

  // -- conversation: per-source ratios combined weighted by prompt_turns -----
  let pTurns = 0, pChars = 0, qTurns = 0, cTurns = 0;
  for (const b of Object.values(perSource)) {
    pTurns += b.prompt_turns ?? 0;
    pChars += b.prompt_chars_total ?? 0;
    qTurns += b.question_turns ?? 0;
    cTurns += b.correction_turns ?? 0;
  }
  // Zero prompt turns: absence, not 0% — every ratio stays null.
  const conversation =
    pTurns > 0
      ? {
          prompt_turns: pTurns,
          correction_turns: cTurns,
          correction_rate_pct: +((cTurns / pTurns) * 100).toFixed(1),
          question_ratio: +(qTurns / pTurns).toFixed(2),
          avg_prompt_chars: Math.round(pChars / pTurns),
          prompt_bucket:
            pChars / pTurns < 80 ? "terse" : pChars / pTurns <= 300 ? "directive" : "spec-writer",
          note: "keyword heuristic (Standout CORRECTION_RE / '?' match), low-signal turns filtered",
        }
      : {
          prompt_turns: 0, correction_turns: null, correction_rate_pct: null,
          question_ratio: null, avg_prompt_chars: null, prompt_bucket: null,
          note: "no qualifying prompt turns",
        };

  // -- delegation + tool mix -------------------------------------------------
  const allTools = new Map();
  let codeToolTotal = 0, handsOn = 0;
  for (const [source, b] of Object.entries(perSource)) {
    for (const [name, n] of Object.entries(b.tool_counts ?? {})) {
      allTools.set(name, (allTools.get(name) ?? 0) + n);
      if (CODE_SOURCES.has(source)) {
        codeToolTotal += n;
        if (HANDS_ON_TOOLS.has(name)) handsOn += n;
      }
    }
  }
  const toolTotal = [...allTools.values()].reduce((a, b) => a + b, 0);
  const share = (n, d) => (d > 0 ? +((n / d) * 100).toFixed(1) : null);
  const sumWhere = (pred) =>
    [...allTools.entries()].reduce((a, [k, v]) => (pred(k) ? a + v : a), 0);
  const delegation = {
    tool_calls: toolTotal,
    delegation_ratio: pTurns > 0 ? +(toolTotal / pTurns).toFixed(1) : null,
    hands_on_code_pct: share(handsOn, codeToolTotal), // cowork excluded (knowledge work)
    orchestration_pct: share(sumWhere((k) => k === "Task"), toolTotal),
    operator_pct: share(sumWhere((k) => OPERATOR_TOOLS.has(k)), toolTotal),
    tool_mix: [...allTools.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({
        name: redactSecrets(name),
        count,
        share_pct: share(count, toolTotal),
      })),
  };

  // -- models: dominant-model session counts by provider ---------------------
  const modelSessions = new Map();
  const providerSessions = { anthropic: 0, openai: 0, other: 0 };
  let modeledSessions = 0;
  for (const s of sessions) {
    if (!s.model) continue;
    modeledSessions += 1;
    modelSessions.set(s.model, (modelSessions.get(s.model) ?? 0) + 1);
    providerSessions[classifyProvider(s.model)] += 1;
  }
  const topModel = [...modelSessions.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const models = {
    provider_sessions: providerSessions,
    model_sessions: Object.fromEntries(
      [...modelSessions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    ),
    top_model: topModel ? topModel[0] : null,
    top_model_share_pct: topModel ? share(topModel[1], modeledSessions) : null,
  };

  // -- concurrency + cadence -------------------------------------------------
  const concurrencySweep = sweepConcurrency(sessions);
  const longestSession = sessions.reduce(
    (best, s) => (s.active_ms > (best?.active_ms ?? -1) ? s : best),
    null
  );
  const concurrency = {
    ...concurrencySweep,
    longest_session_hours: longestSession
      ? +(longestSession.active_ms / 3.6e6).toFixed(1)
      : null,
  };
  const activeDays = sig.active_days ?? [];
  const streaks = computeStreaks(activeDays, todayIso);
  const medMs = median(sessions.map((s) => s.active_ms));
  const cadence = {
    total_sessions: sessions.length,
    active_days: activeDays.length,
    sessions_per_active_day:
      activeDays.length > 0 ? +(sessions.length / activeDays.length).toFixed(1) : null,
    median_session_minutes: medMs != null ? +(medMs / 60000).toFixed(1) : null,
    longest_streak_days: streaks.longest,
    current_streak_days: streaks.current, // zY9: walks back from today; a gap zeroes it
  };

  // -- rhythm ----------------------------------------------------------------
  const hours = Array.isArray(sig.hour_counts) && sig.hour_counts.length === 24
    ? sig.hour_counts
    : new Array(24).fill(0);
  const hourTotal = hours.reduce((a, b) => a + b, 0);
  const peakHour = hourTotal > 0 ? hours.indexOf(Math.max(...hours)) : null;
  const nightEvents = [22, 23, 0, 1, 2, 3, 4].reduce((a, h) => a + hours[h], 0);
  const nightShare = hourTotal > 0 ? +(nightEvents / hourTotal).toFixed(2) : null;
  // Day attribution: whole session lands on its START date (fun_stats.py rule).
  const dayTokens = new Map();
  const dayHours = new Map();
  for (const s of sessions) {
    if (!isFinite(s.start_ts)) continue;
    const day = localDayKey(new Date(s.start_ts));
    const tok = (s.tok?.in ?? 0) + (s.tok?.out ?? 0) + (s.tok?.cr ?? 0) + (s.tok?.cw ?? 0);
    dayTokens.set(day, (dayTokens.get(day) ?? 0) + tok);
    dayHours.set(day, (dayHours.get(day) ?? 0) + s.active_ms / 3.6e6);
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const busiest = top(dayTokens);
  const longestDay = top(dayHours);
  const rhythm = {
    hour_buckets: hours.slice(),
    peak_hour: peakHour,
    weekend_ratio:
      (sig.total_events ?? 0) > 0
        ? +((sig.weekend_events ?? 0) / sig.total_events).toFixed(2)
        : null,
    night_share: nightShare,
    night_owl: nightShare != null ? nightShare >= 0.35 : null,
    busiest_day: busiest ? { date: busiest[0], tokens: busiest[1] } : null,
    longest_day: longestDay
      ? { date: longestDay[0], session_hours: +longestDay[1].toFixed(1) }
      : null,
    day_attribution_note:
      "sessions past midnight count entirely toward their START date; parallel agents mean session-hours can exceed 24h/day",
    active_days: activeDays.slice(),
  };

  // -- token economics -------------------------------------------------------
  let tIn = 0, tOut = 0, tCr = 0, tCw = 0;
  for (const s of sessions) {
    tIn += s.tok?.in ?? 0;
    tOut += s.tok?.out ?? 0;
    tCr += s.tok?.cr ?? 0;
    tCw += s.tok?.cw ?? 0;
  }
  const tokTotal = tIn + tOut + tCr + tCw;
  // Retail cost keyed on the dominant model of each monthly bucket.
  const monthAgg = new Map(); // month -> {tok, models:Map}
  for (const s of sessions) {
    if (!isFinite(s.start_ts)) continue;
    const month = new Date(s.start_ts).toISOString().slice(0, 7);
    let m = monthAgg.get(month);
    if (!m) {
      m = { in: 0, out: 0, cr: 0, cw: 0, models: new Map(), sessions: 0 };
      monthAgg.set(month, m);
    }
    m.in += s.tok?.in ?? 0;
    m.out += s.tok?.out ?? 0;
    m.cr += s.tok?.cr ?? 0;
    m.cw += s.tok?.cw ?? 0;
    m.sessions += 1;
    if (s.model) m.models.set(s.model, (m.models.get(s.model) ?? 0) + 1);
  }
  let retail = 0;
  const monthly = [];
  for (const [month, m] of [...monthAgg.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dom = [...m.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const r = rateForModel(dom);
    const cost =
      (m.in * r.input + m.out * r.output + m.cr * r.cacheRead + m.cw * r.cacheWrite) / 1e6;
    retail += cost;
    monthly.push({
      month,
      sessions: m.sessions,
      tokens: m.in + m.out + m.cr + m.cw,
      new_content: m.in + m.cw + m.out,
      dominant_model: dom,
      retail_cost_usd: +cost.toFixed(2),
    });
  }
  const pctOf = (n) => (tokTotal > 0 ? +((n / tokTotal) * 100).toFixed(1) : null);
  const tokens = {
    fresh_input: tIn,
    cache_write: tCw,
    cache_read: tCr,
    output: tOut,
    total: tokTotal,
    shares_pct: {
      fresh_input: pctOf(tIn),
      cache_write: pctOf(tCw),
      cache_read: pctOf(tCr),
      output: pctOf(tOut),
    },
    new_content: tIn + tCw + tOut,
    work_tokens: tIn + tOut,
    cache_tokens: tCr + tCw,
    retail_cost_usd: tokTotal > 0 ? +retail.toFixed(2) : null,
    cost_note: "retail estimate at list per-Mtok rates, dominant model per month",
    codex_note: perSource.codex
      ? "codex reports no cache-write counter; its share shows 0 by source limitation"
      : null,
    monthly,
  };

  // -- records (fun_stats.py; longest session ranked by DURATION) ------------
  const sessionRef = (s) =>
    s
      ? {
          id: s.id ?? null,
          project: s.project ?? null,
          source: s.source ?? null,
          date: isFinite(s.start_ts) ? localDayKey(new Date(s.start_ts)) : null,
        }
      : null;
  const mostTokens = sessions.reduce((best, s) => {
    const t = (s.tok?.in ?? 0) + (s.tok?.out ?? 0) + (s.tok?.cr ?? 0) + (s.tok?.cw ?? 0);
    return t > (best?.t ?? -1) ? { s, t } : best;
  }, null);
  const mostTurns = sessions.reduce(
    (best, s) => ((s.turns ?? 0) > (best?.turns ?? -1) ? s : best),
    null
  );
  const firstLast = {};
  for (const [source, b] of Object.entries(perSource)) {
    firstLast[source] = {
      label: SOURCE_LABELS[source] ?? source,
      first_seen: b.first_ts != null ? localDayKey(new Date(b.first_ts)) : null,
      last_seen: b.last_ts != null ? localDayKey(new Date(b.last_ts)) : null,
      files: b.files ?? null,
    };
  }
  const records = {
    longest_session: longestSession
      ? { ...sessionRef(longestSession), hours: +(longestSession.active_ms / 3.6e6).toFixed(1) }
      : null,
    most_tokens_session: mostTokens
      ? { ...sessionRef(mostTokens.s), tokens: mostTokens.t }
      : null,
    most_turns_session: mostTurns
      ? { ...sessionRef(mostTurns), turns: mostTurns.turns ?? 0 }
      : null,
    biggest_day: busiest ? { date: busiest[0], tokens: busiest[1] } : null,
    first_last_seen: firstLast,
  };

  // -- languages + projects (craft universe: cowork excluded) ----------------
  const languages = {};
  for (const [source, b] of Object.entries(perSource)) {
    if (!CODE_SOURCES.has(source)) continue;
    for (const [lang, n] of Object.entries(b.languages ?? {}))
      languages[lang] = (languages[lang] ?? 0) + n;
  }
  const projCounts = new Map();
  for (const s of sessions) {
    if (!s.project) continue;
    projCounts.set(s.project, (projCounts.get(s.project) ?? 0) + 1);
  }
  const projects = [...projCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, n]) => ({ name, sessions: n }));

  // -- local proficiency triad (cohort-free gauges, inputs listed) -----------
  const cutoff30 = now - 30 * 864e5;
  const hours30 = sessions
    .filter((s) => isFinite(s.start_ts) && s.start_ts >= cutoff30)
    .reduce((a, s) => a + s.active_ms, 0) / 3.6e6;
  const first = activeDays[0] ? Date.parse(activeDays[0]) : null;
  const last = activeDays[activeDays.length - 1]
    ? Date.parse(activeDays[activeDays.length - 1])
    : null;
  const elapsedDays =
    first != null && last != null ? Math.max(1, Math.round((last - first) / 864e5) + 1) : null;
  const density = elapsedDays ? activeDays.length / elapsedDays : 0;
  const langCount = Object.keys(languages).length;
  const proficiency =
    sessions.length > 0
      ? {
          intensity: {
            gauge: +clamp5(
              lg(hours30, 8) * 0.5 + lg(tokTotal / 1e6, 5) * 0.5
            ).toFixed(1),
            inputs: {
              hours_last_30d: +hours30.toFixed(1),
              total_tokens: tokTotal,
            },
          },
          consistency: {
            gauge: +clamp5(density * 5 * 0.5 + lg(streaks.longest, 3) * 0.5).toFixed(1),
            inputs: {
              active_day_density: +density.toFixed(2),
              longest_streak_days: streaks.longest,
            },
          },
          craft: {
            gauge: +clamp5(
              lg(langCount, 2) * 0.4 +
                ((delegation.hands_on_code_pct ?? 0) / 100) * 5 * 0.3 +
                lg(delegation.delegation_ratio ?? 0, 3) * 0.3
            ).toFixed(1),
            inputs: {
              language_breadth: langCount,
              hands_on_code_pct: delegation.hands_on_code_pct,
              delegation_ratio: delegation.delegation_ratio,
            },
          },
          note: "local gauges 0-5 from listed inputs; no cohort, no percentile, no synthetic score",
        }
      : null;

  return {
    generated_at: new Date(now).toISOString(),
    sources: sources.map((s) => SOURCE_LABELS[s] ?? s),
    files_scanned: sig.files_scanned ?? null,
    conversation,
    delegation,
    models,
    tool_relationship: computeToolRelationship(sessions),
    concurrency,
    cadence,
    rhythm,
    tokens,
    records,
    languages,
    projects,
    proficiency,
    // Same rule as the CLI banner and the stats-page footer: state what is
    // checkable, and never assert the one thing this process cannot prove about
    // itself. ("nothing uploaded" used to be asserted here, in a field that
    // gets written into expanded-*.json.)
    privacy:
      "computed locally from session logs; prompt text was counted in-stream and never stored. This process cannot prove that nothing left the machine — no process can prove that about itself; see PROVE-IT.md §1 for the kernel-level check.",
  };
}

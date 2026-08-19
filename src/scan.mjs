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
import { join, resolve, sep } from "node:path";
import { redactSecrets, maskPath, projectLabel, projectPseudonym } from "./redact.mjs";
// accounts.mjs imports sanitizeModel from here, so this is a cycle. It is safe
// in both load orders because neither module CALLS the other at module scope —
// only function declarations cross the edge.
import { findConfigDirs } from "./accounts.mjs";
// Lazily used inside discoverSources (see SPEC_GET) — sources.mjs pulls
// vscodeRoots from scanners.mjs, which imports this file, so the SPEC is read
// at call time rather than at module load.
import { probe, loadSources } from "./sources.mjs";

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

/**
 * Credit one assistant message's usage, correcting for repeated writes.
 *
 * Claude Code writes the SAME assistant message more than once — up to 19 times
 * in this corpus — as it streams. Every copy carries the same message.id and the
 * same input/cache figures, so counting each row multiplied those by the number
 * of writes: 42.4B tokens claimed where 18.4B were spent.
 *
 * Deduplicating was right. Keeping the FIRST row was not. The early writes hold
 * a PARTIAL output_tokens — literally 8 while the real answer was 434 — and the
 * final value only lands on the last write. First-wins therefore threw away
 * 35.6% of all output tokens (31,005,673 of 87,199,429) on the merged corpus,
 * silently, in the direction that flatters nobody.
 *
 * So: keep the running maximum per field, and credit only the increase. Max
 * rather than last, because a later row must never be able to REDUCE a total —
 * a truncated final write would otherwise erase work that really happened.
 *
 * Returns the deltas to add. `seen` is a Map the caller owns.
 */
export function creditUsage(seen, id, usage) {
  // A TOKEN COUNT IS A COUNT: a non-negative INTEGER, or it is not data.
  //
  // This accepted any finite number and coerced strings, which was itself a
  // repair — `?? 0` had accepted a string outright and `"500" + 0` concatenates
  // rather than adds, so one malformed row could turn a total into "0500…".
  // But coercion goes one step too far in the other direction: it turns `1.5`
  // into one and a half tokens and `"9"` into nine, and a counter that accepts
  // 1.5 of something will accept "1e9" and " 9 " on the same reasoning.
  //
  // accounts.mjs required an integer and this did not, which is how folding the
  // two together surfaced it. Checked before choosing: 73,209 real usage rows
  // across four live profiles contain ZERO non-integer values, so the strict
  // rule costs nothing that exists and cannot invent anything that does not.
  // A malformed field contributes nothing and leaves the running maximum for
  // that field where it was — it is not evidence that the field is now zero.
  //
  // TWO TESTS ENCODED OPPOSITE RULES and folding accounts.mjs onto this
  // function is what surfaced it: hardening.test.mjs asserts `"500"` coerces to
  // 500, accounts.test.mjs asserted `"9"` is skipped. Resolved toward COERCING
  // AN INTEGER WRITTEN AS A STRING, because a serialiser emitting "9" is a real
  // thing and dropping it loses nine tokens silently — and silent loss is the
  // failure this whole system is built against. A value that is not a whole
  // number is still refused: 1.5 tokens is not a count, and a rule that accepts
  // it would accept "1e9" and " 9 " on the same reasoning.
  const num = (v) => {
    const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
    return Number.isInteger(n) && n >= 0 ? n : 0;
  };
  const cur = {
    in: num(usage?.input_tokens),
    out: num(usage?.output_tokens),
    cr: num(usage?.cache_read_input_tokens),
    cw: num(usage?.cache_creation_input_tokens),
  };
  // No id means nothing to correlate it with, so it is its own message.
  if (!id) return cur;
  const prev = seen.get(id);
  if (!prev) {
    seen.set(id, { ...cur });
    return cur;
  }
  const delta = { in: 0, out: 0, cr: 0, cw: 0 };
  for (const k of ["in", "out", "cr", "cw"]) {
    if (cur[k] > prev[k]) {
      delta[k] = cur[k] - prev[k];
      prev[k] = cur[k];
    }
  }
  return delta;
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
    nightMinutesByMonth: new Map(), // "YYYY-MM" -> the same minutes, per month

    activeDays: new Set(),
    weekendEvents: 0,
    totalEvents: 0,
    userTurns: 0,
    seenMessageIds: new Map(),
    // Projects counted from the TRANSCRIPTS, independent of how sessions merge.
    // A sub-agent transcript carries its PARENT's sessionId while living in its
    // own project directory, so session-based counting credits only whichever
    // directory was read first: on the fleet corpus that turned 350 project
    // directories into 104. A project is a place work happened, not a property
    // of a session id.
    projectsSeen: new Map(), // encoded dir name -> that directory's project label
  };
}

// ---- source discovery ------------------------------------------------------

// Claude Code PROFILE directories under (or at) `root`.
//
// discoverSources used to hardcode ONE profile per root, join(root,".claude").
// Measured on this machine: .claude holds 340 transcripts and four more
// profiles hold 1,346 the scan could not see — .claude-alt 1,212, .my-claude
// 130, .claude-it 3, .claude-alt-api 1 — and no flag reached them, because
// --roots takes HOME directories and the "/.claude" suffix is re-appended, so
// discoverSources(["/home/me/.claude-alt"]) returned 0 files.
//
// findConfigDirs is accounts.mjs's discovery — by SHAPE (a directory whose
// projects/ holds a .jsonl), name-glob then $CLAUDE_CONFIG_DIR then a depth-4
// walk — reused rather than reimplemented so the two halves of this tool can
// never disagree about which profiles exist. It enumerates profiles under a
// HOME, so a root that IS a profile directory is added here: that is the case
// --roots could not express.
//
// `outside` collects what discovery offered that this root does not CONTAIN.
// findConfigDirs also honours $CLAUDE_CONFIG_DIR, and its "only for the real
// home" guard tests homedir() — which follows $HOME. So with $HOME pointed at
// a fixture, findConfigDirs(<empty temp dir>) returns the live
// /home/…/.claude-alt and its 1,212 transcripts: 9 tests' fixture totals wrong,
// and a scan that is not a function of its roots. A scan of a root reads that
// root; anything else is named out loud below and is reached by putting it in
// --roots, which takes a profile directory now.
function claudeProfileDirs(root, outside) {
  const base = resolve(root);
  const dirs = [];
  for (const d of findConfigDirs(root)) {
    const p = resolve(d);
    if (p === base || p.startsWith(base + sep)) dirs.push(d);
    else outside.add(p);
  }
  if (existsSync(join(root, "projects"))) dirs.unshift(root);
  return dirs;
}

// THE SCAN DEGRADES; IT DOES NOT DIE. `sources` refuses to run without the
// spec because a source list it cannot read is the whole answer to that
// question. A SCAN is different: Claude discovery does not need the spec at
// all, so a missing or unreadable spec must not take the count with it. It
// falls back to the paths that were hardcoded here before, says so once on
// stderr, and counts what it can — a broken install that reports fewer sources
// out loud beats one that reports nothing with a stack trace.
let _SPEC = null;
let _SPEC_WARNED = false;
function SPEC_GET() {
  if (_SPEC !== null) return _SPEC;
  try {
    _SPEC = loadSources();
  } catch (e) {
    if (!_SPEC_WARNED) {
      _SPEC_WARNED = true;
      process.stderr.write(
        `note: spec/sources.json could not be read (${e.message.split(":")[0]}) — `
        + `falling back to built-in paths for Cowork and Codex. Claude Code is `
        + `unaffected. A complete install ships spec/.\n`);
    }
    _SPEC = { sources: [] };
  }
  return _SPEC;
}

// The paths this file used to type, kept ONLY as that fallback.
const BUILTIN = {
  cowork: [["Library", "Application Support", "Claude", "local-agent-mode-sessions"],
           [".config", "Claude", "local-agent-mode-sessions"]],
  codex: [[".codex", "sessions"]],
};

export function discoverSources(roots) {
  const SPEC = SPEC_GET();
  const found = [];
  const outside = new Set();
  for (const root of roots) {
    for (const dir of claudeProfileDirs(root, outside)) {
      // Depth 6, was 2. Claude Code nests sub-agent and workflow transcripts at
      // projects/<proj>/<session>/subagents/workflows/<wf>/agent.jsonl — five
      // directories below projects/ — so depth 2 reached 85 of this machine's
      // 1,686 profile transcripts and left 5,875,900,498 tokens unread.
      // Deeper enumeration cannot double count: creditUsage() keys on
      // message.id across the WHOLE scan, and 323 of the 46,723 distinct ids
      // really do appear in a second file, carrying 32,630,080 tokens that are
      // therefore credited exactly once.
      for (const f of listJsonl(join(dir, "projects"), 6))
        found.push({ source: "claude_code", root, path: f });
    }
    // COWORK AND CODEX COME FROM THE SPEC, NOT FROM A PATH TYPED HERE.
    //
    // The cowork base was `<root>/Library/Application Support/...` and nothing
    // else, so on Linux and Windows this scan could never see it — while
    // `starreckon sources`, guessing from `kind`, reported it as installed.
    // Two files with two ideas of where one tool lives, and the user is told
    // the one that is wrong. spec/sources.json declares the bases per platform
    // and `probe()` walks them; both callers now read the same list.
    //
    // The depth stays here: how deep to walk is behaviour, and Cowork nests a
    // whole Claude profile seven levels down while Codex is a date tree five
    // deep. The spec says where to start.
    for (const [name, depth] of [["cowork", 7], ["codex", 5]]) {
      const src = SPEC.sources.find((x) => x.name === name);
      const bases = src
        ? probe(src, root, SPEC).found
        : BUILTIN[name].map((segs) => join(root, ...segs)).filter(existsSync);
      for (const base of bases) {
        for (const f of listJsonl(base, depth))
          found.push({ source: name, root, path: f });
      }
    }
  }
  // Skipped by ONE root may still be covered by another, so the report is made
  // against the whole list. A profile that was found and not read must never
  // read as a profile that does not exist.
  for (const p of outside)
    if (roots.some((r) => p === resolve(r) || p.startsWith(resolve(r) + sep)))
      outside.delete(p);
  for (const p of outside)
    process.stderr.write(
      `note: ${maskPath(p)} is a Claude profile directory but is not under any scanned root — NOT read. Add it to --roots to include it.\n`
    );
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

export async function streamLines(filePath, onLine) {
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
  //
  // Kept per MONTH as well, because a month's star is scored by the same
  // function as the lifetime star and so has to be handed the same unit. The
  // monthly buckets carried no night_hours at all, so every one of them fell
  // through to that per-event fallback: measured on this corpus, 137.3 real
  // night hours were drawn as 450,107 — the 00:00-05:59 log LINE count — and
  // OUTSIDE THE BOX saturated at 7.0 for 2026-05, 2026-07, 2026-08 and for the
  // lifetime star. Keyed by the LOCAL month, the same rule the day sets use: a
  // 02:00 minute belongs to the month it happened in, whatever month the
  // session it belongs to started in. Months partition time, so these sets sum
  // back to nightMinutes exactly.
  if (d.getHours() < 6) {
    const minute = Math.floor(ts / 60000);
    stats.nightMinutes.add(minute);
    const key = localDayKey(d).slice(0, 7);
    let perMonth = stats.nightMinutesByMonth.get(key);
    if (!perMonth) stats.nightMinutesByMonth.set(key, (perMonth = new Set()));
    perMonth.add(minute);
  }
  const day = d.getDay();
  if (day === 0 || day === 6) stats.weekendEvents += 1;
  stats.activeDays.add(localDayKey(d));
}

// Claude Code + Cowork share the transcript format.
/**
 * The project a transcript belongs to, from its DIRECTORY.
 *
 * Claude Code stores each project's sessions in ~/.claude/projects/<dir>, where
 * <dir> is the working directory with separators replaced by dashes. That
 * directory IS the project identity; `cwd` inside the rows is a convenience copy
 * of the same thing.
 *
 * Reading only `cwd` loses the identity whenever the two disagree. On the merged
 * fleet corpus every row's cwd had been redacted to the single string
 * "/workspace" while the 401 project directories survived intact, so 401
 * projects were counted as ONE — and ENGINEERING, which is scored partly on
 * project count, was measuring the redaction rather than the person.
 *
 * cwd is still preferred when it says something: it is the un-encoded path and
 * makes the nicer label. This is the fallback for when it does not.
 */
// A cwd that cannot distinguish one project from another: a single path
// segment, i.e. a bare root. "/workspace" is what the fleet corpus redaction
// leaves behind for every session it exports.
function uninformativeCwd(cwd) {
  return String(cwd ?? "").split(/[/\\]/).filter(Boolean).length <= 1;
}

// The ENCODED project directory a transcript lives in.
//
// .../projects/<dir>/<session>.jsonl -> <dir>, and equally
// .../projects/<dir>/<session>/subagents/workflows/<wf>/agent.jsonl -> <dir>.
// The PARENT directory used to be that answer, and it was right only while the
// walk stopped one level below projects/. It stops five levels below now, and
// 1,557 of this machine's 1,686 transcripts have a parent directory literally
// named "subagents" or "wf_<hex>" — reading the parent would have registered
// those strings as project names and lost the real project for every one.
//
// No "projects" component in the path (Cowork's local-agent-mode-sessions
// layout) falls back to the parent, which is what that layout means.
export function projectDirOf(filePath) {
  const parts = String(filePath ?? "").split(/[/\\]/).filter(Boolean);
  const i = parts.lastIndexOf("projects");
  // i + 1 must still be a DIRECTORY — at parts.length - 1 it is the file.
  if (i >= 0 && i + 1 < parts.length - 1) return parts[i + 1];
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

export function projectFromPath(filePath) {
  const dir = projectDirOf(filePath);
  if (!dir || dir === "projects") return null;
  // Claude Code's encoding: leading dash is the root, inner dashes are
  // separators. Decoding is lossy for names that contain dashes, which is fine
  // — this is a LABEL, and the identity is the string either way.
  const decoded = dir.startsWith("-") ? "/" + dir.slice(1).replace(/-/g, "/") : dir;
  return projectLabel(decoded) ?? dir;
}

export async function parseClaudeFile(filePath, stats, opts = {}) {
  // Resolved once per file, used only when cwd cannot identify the project.
  const dirProject = projectFromPath(filePath);
  // Keyed by the ENCODED directory name, which is unique per real directory. The
  // DECODED label is NOT: ~/work/acme/api-server and ~/work/globex/api-server
  // both decode to "api/server", because the decode window keeps only the last
  // two segments and the dash-decode has already shifted the real parent out of
  // it. Keying by the decoded label loses exactly what decoding lost — ten
  // client repos counted as one project while all ten were still displayed.
  const dirKey = projectDirOf(filePath);
  if (dirKey && dirProject && !opts.excluded?.(dirProject))
    stats.projectsSeen?.set(dirKey, dirProject);
  // The fallback session id must be unique across the WHOLE scan, so it carries
  // the project directory too. A bare basename is not an identity: 83 different
  // projects in the fleet corpus each had a "journal.jsonl", and all 83 merged
  // into one session — taking 82 projects with them, because a session's project
  // is set once and the first directory seen wins.
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  let sessionId = parts.slice(-2).join("/").replace(/\.jsonl$/, "");
  await streamLines(filePath, (line) => {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    // JSON.parse("null") SUCCEEDS and returns null, and the very next line reads
    // d.timestamp — a TypeError thrown from inside the stream callback, which
    // aborts the rest of the FILE. The caller catches it with a bare `catch {}`,
    // so the rows already read are kept and every row after the bad line is
    // dropped without a word: a 9-row transcript with a null on line 2 reported
    // 100 tokens instead of 900. A half-written final line is exactly what a
    // killed process leaves behind. Only null does this — true, 42, "x" and []
    // all give undefined on property access and fall out at the isNaN below.
    if (d === null || typeof d !== "object" || Array.isArray(d)) return;
    const ts = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
    if (isNaN(ts)) return;
    if (typeof d.sessionId === "string") sessionId = d.sessionId;
    temporal(stats, ts);
    const s = session(stats, sessionId, ts);
    if (typeof d.cwd === "string" && !s.project) {
      const label = projectLabel(d.cwd);
      if (opts.excluded?.(d.cwd)) s.project = "[excluded]";
      // The directory wins when cwd is UNINFORMATIVE — a bare root like
      // "/workspace" that every session in every directory shares. Preferring
      // cwd otherwise keeps normal scans byte-identical, since there the two
      // encode the same path.
      else if (label) {
        // The directory fallback has to obey the exclusion prompt as well. It
        // was only ever applied to d.cwd, so a user who excluded a private
        // client directory still got its NAME into the reports whenever cwd was
        // uninformative — which is exactly when the directory is used.
        const useDir = uninformativeCwd(d.cwd) && dirProject && !opts.excluded?.(dirProject);
        s.project = useDir ? dirProject : label;
      }
    }
    // No cwd at all (redacted away, or a transcript that never carried one).
    if (!s.project && dirProject && !opts.excluded?.(dirProject)) s.project = dirProject;
    // THIS file's cwd and THIS file's directory name the same project, so the
    // two spellings can be folded together. Keyed off the file's own cwd rather
    // than off s.project: a session can span directories (a sub-agent transcript
    // carries its parent's id), and s.project is whichever directory was read
    // first — aliasing dirProject onto that would collapse three real projects
    // into one and undo the sub-agent fix.
    if (dirKey && dirProject && typeof d.cwd === "string" && !uninformativeCwd(d.cwd)) {
      // Rewrite THIS directory's own entry to the un-encoded spelling the
      // session also uses, so the two witnesses agree. Per-directory, so two
      // directories that happen to decode alike remain two projects.
      if (opts.excluded?.(d.cwd)) stats.projectsSeen?.delete(dirKey);
      else {
        const alias = projectLabel(d.cwd);
        if (alias) stats.projectsSeen?.set(dirKey, alias);
      }
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
      if (u) {
        const d = creditUsage(stats.seenMessageIds, id, u);
        s.tok.in += d.in;
        s.tok.out += d.out;
        s.tok.cr += d.cr;
        s.tok.cw += d.cw;
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
  // Per FILE, not per session: the inherited prefix belongs to this rollout.
  // [input, cached_input, output] throughout. See the comment at the
  // total_token_usage branch below for what each one is holding back.
  let base = null;          // what this file's total already held on arrival
  let carry = [0, 0, 0];    // segments completed before a mid-stream reset
  let prevRaw = null;       // previous absolute total, to see a reset happen
  let applied = [0, 0, 0];  // what THIS file has already handed to the session
  await streamLines(filePath, (line) => {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    // JSON.parse("null") SUCCEEDS and returns null, and the very next line reads
    // d.timestamp — a TypeError thrown from inside the stream callback, which
    // aborts the rest of the FILE. The caller catches it with a bare `catch {}`,
    // so the rows already read are kept and every row after the bad line is
    // dropped without a word: a 9-row transcript with a null on line 2 reported
    // 100 tokens instead of 900. A half-written final line is exactly what a
    // killed process leaves behind. Only null does this — true, 42, "x" and []
    // all give undefined on property access and fall out at the isNaN below.
    if (d === null || typeof d !== "object" || Array.isArray(d)) return;
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
      // total_token_usage IS CUMULATIVE OVER THE LINEAGE, NOT OVER THE FILE.
      //
      // Assigning it whole counted a resumed or forked session's INHERITED
      // prefix again in every child file. Measured against deadreckon over the
      // 156 Codex files on this fleet: 3,340,774,041 here against 2,319,394,230
      // there, and the 1,021,379,811 gap closes exactly — 17 files open with an
      // inherited running total summing to 1,021,393,809, one file resets
      // mid-stream and loses 13,998, and 1,021,393,809 - 13,998 is the gap to
      // the token. Ten sibling forks share one identical 69,322,178 base, so
      // that prefix alone was counted ten times: 623,899,602 tokens.
      //
      // The field is not wrong and neither is deadreckon's read of
      // last_token_usage: on the live store (~/.codex/sessions, 4 files) both
      // programs return 1,453,618, bucket-for-bucket. total[n] equals the sum
      // of the DEDUPED last[0..n] exactly, 0 mismatches over 117 records. So
      // the prefix is recoverable from the file's own first record: whatever
      // its total already held BEYOND that record's own last was inherited.
      //
      // The two failure modes are opposite-signed, which is why the reset half
      // is here too. A session that resets restarts its total from zero, and
      // subtracting a base alone would silently drop the segment before it —
      // that is the -13,998 above, and no single-direction assertion catches
      // both. Completed segments accumulate into `carry`.
      // AND IT ACCUMULATES ACROSS FILES, because `=` lost whole files. Six
      // session ids on this fleet appear in more than one rollout, and a plain
      // assign meant the last file parsed replaced the others rather than
      // adding to them. That was survivable while each file carried the whole
      // lineage total; once a file contributes only its own segment it is not.
      // `applied` is what THIS file has already handed over, so re-reading a
      // record adds nothing and the running total stays idempotent.
      const last = payload.info.last_token_usage;
      const bucket = (x) => [x?.input_tokens ?? 0, x?.cached_input_tokens ?? 0,
                             x?.output_tokens ?? 0];
      const inherited = () =>
        // No last_token_usage means the inherited prefix cannot be recovered
        // from this record, so claim none — that is the pre-fix behaviour, kept
        // deliberately rather than guessed at.
        last ? raw.map((v, i) => Math.max(0, v - bucket(last)[i])) : [0, 0, 0];
      const raw = bucket(t);
      const sum = (a) => a[0] + a[1] + a[2];
      if (base === null) {
        base = inherited();
      } else if (prevRaw && sum(raw) < sum(prevRaw)) {
        // The total restarted. Bank the segment that just ended — subtracting a
        // base alone would drop it, and that is the under-count half of the
        // pair. Measured: one file on this fleet, -13,998.
        carry = carry.map((v, i) => v + Math.max(0, prevRaw[i] - base[i]));
        base = inherited();
      }
      prevRaw = raw;
      const want = raw.map((v, i) => carry[i] + Math.max(0, v - base[i]));
      const net = (a) => [Math.max(0, a[0] - a[1]), a[1], a[2]];
      const [wIn, wCr, wOut] = net(want);
      const [aIn, aCr, aOut] = net(applied);
      s.tok.in += wIn - aIn;
      s.tok.cr += wCr - aCr;
      s.tok.out += wOut - aOut;
      applied = want;
      if (model) s.models.set(model, (s.models.get(model) ?? 0) + 1);
    } else if (d.type === "response_item" && payload) {
      if (payload.type === "function_call" || payload.type === "local_shell_call") {
        // sanitizeModel, exactly as the Claude branch 80 lines above does for
        // item.name. A tool NAME is attacker-supplied text — MCP servers name
        // their own tools — and this branch wrote it into tool_call_counts raw,
        // so a Codex rollout naming a tool after a credential put that
        // credential verbatim into reports/expanded-*.json.
        const name = sanitizeModel(payload.name) || "shell";
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
  let total = 60000; // base: the first minute always contributes 60 s
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
  // Sessions with no timestamp: counted in the totals above but invisible in
  // every dated breakdown (months, streaks, active days). The count and their
  // token contribution are surfaced separately so the gap between
  // "total sessions" and "sessions with a date" is never silently hidden.
  let undatedCount = 0;
  let undatedTok = 0;
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
    } else {
      undatedCount += 1;
      undatedTok += s.tok.in + s.tok.out + s.tok.cr + s.tok.cw;
    }
  }
  const streaks = computeStreaks(stats.activeDays);
  return {
    total_sessions: stats.sessions.size,
    sessions_without_date: undatedCount,
    tokens_without_date: undatedTok,
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
    // The UNION of projects reached by a session and projects seen on disk.
    // Session-derived alone under-counts (sub-agent transcripts share their
    // parent's session id across directories); file-derived alone would miss a
    // caller that builds sessions without files. Either witness counts.
    projects_count: new Set([
      ...[...projects.keys()].filter((p) => p && p !== "[excluded]"),
      ...(stats.projectsSeen instanceof Map
        ? stats.projectsSeen.values()
        : (stats.projectsSeen ?? [])),
    ]).size,
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
        // Top 5 project labels for this month — stored so cardProjects can render
        // from a lifetime view after logs age off. Same two-segment masking as the
        // top-level agg.projects; --no-projects is applied at write time in cli.mjs
        // via forFiles(), which already masks this field. The count is the star axis
        // input (projects_count above, uncapped); these names are display only.
        top_projects: [...b.projects.entries()]
          .sort((x, y) => y[1] - x[1])
          .slice(0, 5)
          .map(([name, sessions]) => ({ name, sessions })),
        models: Object.fromEntries([...b.models.entries()].sort((x, y) => y[1] - x[1])),
        hour_buckets: b.hours,
        // Real hours, from the same distinct-minute set and the same 00:00-05:59
        // window the top-level night_hours uses — so a month and the lifetime
        // are scored on one scale. This is the axis input; hour_buckets above it
        // is the per-EVENT histogram the stats page draws, and is not hours.
        night_hours: +((stats.nightMinutesByMonth?.get(month)?.size ?? 0) / 60).toFixed(1),
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
  // localDayKey for "today", because every entry in `sorted` is a LOCAL day key.
  // Reading today in UTC compared two different calendars: west of Greenwich the
  // UTC date rolls over in the evening, so the SAME history scored a live streak
  // at 10:00 and a broken one at 20:00 on the same day. Both sides are now the
  // local calendar date, parsed identically.
  const daysSinceLast = Math.round(
    (Date.parse(localDayKey(new Date())) - Date.parse(sorted[sorted.length - 1])) / dayMs
  );
  if (daysSinceLast > 1) current = 0;
  return { longest, current };
}

export function defaultRoots() {
  return [homedir()];
}

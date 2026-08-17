// Protection layer for AI-coding session files.
//
// Two layers, neither destructive — ported from deadreckon-count/retention_guard.py:
//
// LAYER 1 — raise cleanupPeriodDays (Claude only)
//   Claude Code deletes transcripts older than cleanupPeriodDays AT STARTUP.
//   Default is 30. This raises it to 36500 (100 years) in every discovered
//   profile's settings.json. Cleanup still runs; it simply never matches.
//   Never lowers the value. Backs up settings.json once before first edit.
//   Atomic write (tmp + rename) so a crash mid-write cannot corrupt the config.
//
// LAYER 2 — hard-link archive (all CLI stores)
//   Every session file from every CLI gets a hard link under
//   ~/.ai-logs-archive/<store>/<same relative path>. A hard link is a second
//   NAME for the same inode: when a tool deletes its own copy the bytes live on
//   under this name. Costs zero extra disk space (same blocks). Only .jsonl,
//   .json, .db, .db-wal session files — never credentials, OAuth tokens, or
//   config files.
//
// Claude is the only CLI that auto-deletes. The archive is for all CLIs because
// any of them COULD delete tomorrow, and the archive costs nothing.
//
// NEVER lowers cleanupPeriodDays. NEVER archives credential files. NEVER
// crosses filesystem boundaries (hard links cannot). NEVER modifies any tool's
// own data — read-only on the source side; only creates links in the archive.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  statSync, writeFileSync, linkSync, lstatSync, unlinkSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, sep } from "node:path";

const TARGET_DAYS = 36500; // 100 years — cleanup runs, never matches

// Directories never worth walking when looking for a profile.
const SKIP_WALK = new Set([
  ".cache", ".npm", ".gradle", ".wine", ".git", "node_modules",
  "__pycache__", ".venv", "venv", "site-packages", ".rustup",
  ".cargo", ".mozilla", ".thunderbird", ".ai-logs-archive",
  "Library", "AppData", "corpus", "merged", "archive",
  "snap", ".Trash", "Trash",
]);

// Directories whose name signals credentials — never link anything inside.
const SECRET_DIRS = new Set([
  "mcp-secrets", "credentials", ".credentials", "secrets", "tokens",
  "auth", "oauth", ".ssh", "keychain",
]);

// File names that are credentials, never session records.
const SECRET_NAMES = new Set([
  ".credentials.json", "credentials.json", "oauth_creds.json",
  "google_accounts.json", "installation_id", "token", "session-id",
  ".env", "config.json", "auth.json",
]);

// Extensions we archive. Everything else is ignored. Extensionless records
// (~/.ollama/history) are archived too — see isArchivable.
const ARCHIVE_EXTS = new Set([".jsonl", ".json", ".db", ".db-wal", ".ndjson"]);

// ---- filesystem helpers ----------------------------------------------------

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
function devIno(p) {
  // (dev, ino) pair to detect same inode. Returns null on error.
  try {
    const s = lstatSync(p);
    return s.ino !== 0 ? `${s.dev}:${s.ino}` : null;
  } catch { return null; }
}
function sameFile(a, b) {
  const ka = devIno(a), kb = devIno(b);
  return ka !== null && ka === kb;
}
function sameDev(a, b) {
  // Hard links require same filesystem. Check device numbers.
  try {
    const sa = statSync(a), sb = statSync(b);
    return sa.dev === sb.dev;
  } catch { return false; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

// ---- credential guard ------------------------------------------------------

// A CREDENTIAL IS RECOGNISED BY SHAPE, NOT BY BEING ON A LIST OF TEN NAMES.
//
// SECRET_NAMES held `oauth_creds.json` and this let `oauth-keys.json` — one
// character different — through with its .json extension into
// ~/.ai-logs-archive/aider/, on every tick, under a header that says "NEVER
// archives credential files". An exact-name denylist cannot keep a promise
// about files it has not seen; the next tool's `api-key.json` or
// `refresh_token.json` would sail through the same way. So the exact list stays
// (it is cheap and it names the known offenders) and a pattern test sits beside
// it: any name carrying a credential-shaped word is refused, whatever the
// extension.
//
// It is NOT a bare-word match on "token". The first draft was, and it refused
// `token_ledger.jsonl` and `token-usage.json` — this program's own record and
// deadreckon's — which are exactly the files the archive exists to keep. A
// credential file says what KIND of secret it is: `oauth-keys`, `api_key`,
// `refresh_token`, `access_token`, `id_rsa`. A record file uses the word as a
// unit of measure. The pattern names the credential compounds, and leaves the
// bare word alone.
const SECRET_SHAPE = /(?:^|[._-])(?:oauth(?:[._-]?(?:keys?|creds?|tokens?))?|secrets?|credentials?|creds|api[._-]?keys?|apikeys?|auth(?:[._-]?tokens?)?|passwords?|passwd|private[._-]?keys?|id_rsa|id_ed25519|id_ecdsa|refresh[._-]?tokens?|access[._-]?tokens?|bearer|session[._-]?keys?|cookies?[._-]?(?:jar|store|txt))(?:$|[._-])/i;

function isSecretName(name) {
  const n = name.toLowerCase();
  return SECRET_NAMES.has(n) || SECRET_SHAPE.test(n);
}
function hasSecretAncestor(rel) {
  // rel is relative to the store root — check each component.
  for (const part of rel.split(sep)) {
    if (SECRET_DIRS.has(part.toLowerCase())) return true;
  }
  return false;
}
function isArchivable(fullPath, relToStore) {
  const name = basename(fullPath).toLowerCase();
  if (isSecretName(name)) return false;
  if (hasSecretAncestor(relToStore)) return false;
  // An extensionless record is still a record. `"history".lastIndexOf(".")` is
  // -1 and slice(-1) returned "y", so ~/.ollama/history (4,422 bytes) failed
  // the ARCHIVE_EXTS test and was never linked. Names with no dot are
  // archivable; the credential guards above already reject the extensionless
  // secrets (installation_id, token, session-id).
  const dot = name.lastIndexOf(".");
  if (dot === -1) return true;
  const ext = name.slice(dot);
  if (!ARCHIVE_EXTS.has(ext)) return false;
  return true;
}

// ---- Claude profile discovery (by SHAPE, not by name) ----------------------
// Port of analyze_tokens.find_config_dirs + retention_guard.find_profiles.
// A Claude profile is any directory containing projects/ with at least one
// .jsonl beneath it. Walked to depth 4 from home.

function looksLikeClaudeProfile(p) {
  const proj = join(p, "projects");
  if (!isDir(proj)) return false;
  // At least one .jsonl anywhere beneath projects/
  const check = (dir, depth) => {
    if (depth < 0) return false;
    let entries;
    try { entries = readdirSync(dir); } catch { return false; }
    for (const e of entries) {
      if (e.endsWith(".jsonl")) return true;
      const full = join(dir, e);
      if (isDir(full) && check(full, depth - 1)) return true;
    }
    return false;
  };
  return check(proj, 4);
}

/**
 * Profiles under `home`, plus whatever $CLAUDE_CONFIG_DIR points at.
 *
 * `configDir` is a parameter and not a bare `process.env` read because the env
 * read made this function non-hermetic: handed a fresh temp home it still
 * returned the developer's own alternate profile, because the variable was set
 * in that shell and pointed outside the home it was given. Three tests failed,
 * and the failure was the honest half — the dangerous half is that a test
 * asserting "empty home -> []" would have PASSED on any machine where the
 * variable happened to be unset, and failed only on the machines that actually
 * use it. A suite whose verdict depends on ambient environment is not a suite.
 *
 * Production behaviour is unchanged: the default is still the live variable,
 * which is the whole reason it is honoured — CLAUDE_CONFIG_DIR may point
 * anywhere at all, and a scan bounded by `home` would never find it.
 */
export function findClaudeProfiles(home, { configDir = process.env.CLAUDE_CONFIG_DIR } = {}) {
  home = home ?? homedir();
  const seen = new Set();
  const out = [];

  const add = (p) => {
    let key;
    try {
      const s = statSync(p);
      key = s.ino !== 0 ? `${s.dev}:${s.ino}` : p;
    } catch { return; }
    if (seen.has(key)) return;
    if (!looksLikeClaudeProfile(p)) return;
    seen.add(key);
    out.push(p);
  };

  // Fast path: ~/.claude* (common case)
  let top;
  try { top = readdirSync(home); } catch { return out; }
  for (const e of top) {
    if (e.startsWith(".claude")) {
      const full = join(home, e);
      if (isDir(full)) add(full);
    }
  }

  // $CLAUDE_CONFIG_DIR may point anywhere
  if (configDir) add(configDir);

  // Deep walk for copies/alternate profiles
  const walk = (dir, depth) => {
    if (depth < 0) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (SKIP_WALK.has(e)) continue;
      const full = join(dir, e);
      let isD;
      try { isD = statSync(full).isDirectory(); } catch { continue; }
      if (!isD) continue;
      // Skip the archive itself — it holds copies, not live profiles
      if (full === join(home, ".ai-logs-archive")) continue;
      if (isDir(join(full, "projects"))) add(full);
      walk(full, depth - 1);
    }
  };
  walk(home, 4);
  return out;
}

// ---- Layer 1: raise cleanupPeriodDays --------------------------------------

function settingsPath(profile) {
  return join(profile, "settings.json");
}

function currentPeriod(profile) {
  const p = settingsPath(profile);
  if (!isFile(p)) return 30; // Claude's default
  const d = readJsonSafe(p);
  const v = d?.cleanupPeriodDays;
  return typeof v === "number" && Number.isFinite(v) ? v : 30;
}

/**
 * Raise cleanupPeriodDays to TARGET_DAYS in one profile.
 * Returns { changed, message } — plus failed:true on the two write-error paths,
 * because `changed:false` alone also means "already 36500, nothing to do".
 * dry=true: report what would happen, change nothing.
 */
export function raisePeriod(profile, { dry = false } = {}) {
  const p = settingsPath(profile);
  if (!isFile(p)) {
    // No settings.json — create one with just cleanupPeriodDays
    if (dry) return { changed: true, message: `no settings.json → would create with ${TARGET_DAYS}` };
    try {
      writeFileSync(p, JSON.stringify({ cleanupPeriodDays: TARGET_DAYS }, null, 2) + "\n", "utf-8");
      return { changed: true, message: `created settings.json with cleanupPeriodDays=${TARGET_DAYS}` };
    } catch (e) {
      // failed:true is what separates this from `{changed:false,"already 36500"}`.
      // Without it an EACCES profile is indistinguishable from a protected one.
      return { changed: false, failed: true, message: `could not create settings.json: ${e.message}` };
    }
  }
  const cur = currentPeriod(profile);
  if (cur >= TARGET_DAYS) {
    return { changed: false, message: `already ${cur}` };
  }
  if (dry) {
    return { changed: true, message: `${cur} → ${TARGET_DAYS} (dry run, not applied)` };
  }
  let doc = readJsonSafe(p) ?? {};
  // Back up once before the first edit
  const bak = p + ".before-starreckon";
  if (!existsSync(bak)) {
    try { writeFileSync(bak, readFileSync(p)); } catch { /* best-effort */ }
  }
  doc.cleanupPeriodDays = TARGET_DAYS;
  const tmp = p + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf-8");
    renameSync(tmp, p); // atomic: crash mid-write cannot leave a truncated config
    return { changed: true, message: `${cur} → ${TARGET_DAYS}` };
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    return { changed: false, failed: true, message: `write failed: ${e.message}` };
  }
}

// ---- Layer 2: hard-link archive --------------------------------------------

const archiveRoot = (home) => join(home ?? homedir(), ".ai-logs-archive");

/**
 * Hard-link all session files under `src` into ARCHIVE/label/.
 * Returns { linked, skipped, failed, barrier }.
 *
 * barrier is set when linking is impossible (different filesystem, unwritable
 * archive). In that case linked=skipped=failed=0 and nothing was attempted.
 */
export function linkTree(src, label, { home = null, dry = false } = {}) {
  const archive = archiveRoot(home);
  const destRoot = join(archive, label);

  if (!isDir(src) && !isFile(src)) {
    return { linked: 0, skipped: 0, failed: 0, status: "absent" };
  }

  // Filesystem check BEFORE creating destination directory.
  // Hard links cannot cross filesystems.
  const srcDev = (() => { try { return statSync(src).dev; } catch { return null; } })();
  if (srcDev === null) return { linked: 0, skipped: 0, failed: 0, status: "unreadable" };

  // Check if archive is on same filesystem (create parent if needed to check)
  try { mkdirSync(archive, { recursive: true }); } catch { /* ignore */ }
  const archiveDev = (() => { try { return statSync(archive).dev; } catch { return null; } })();
  if (archiveDev !== null && srcDev !== archiveDev) {
    return { linked: 0, skipped: 0, failed: 0,
      barrier: "DIFFERENT FILESYSTEM — hard links impossible here" };
  }

  if (!dry) {
    try { mkdirSync(destRoot, { recursive: true }); } catch (e) {
      return { linked: 0, skipped: 0, failed: 0,
        barrier: `archive not writable: ${e.message}` };
    }
  }

  let linked = 0, skipped = 0, failed = 0;
  const errors = [];

  const walk = (dir, relBase) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries.sort()) {
      const full = join(dir, e);
      const rel = relBase ? relBase + sep + e : e;
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!st.isFile()) continue;
      if (!isArchivable(full, rel)) continue;

      // Where this inode belongs in the archive.
      // If destination exists but is a DIFFERENT inode (file was rewritten),
      // archive alongside it using inode number in the name.
      const dest = join(destRoot, rel);
      const destDir = dirname(dest);

      let targetDest = dest;
      if (existsSync(dest)) {
        if (sameFile(full, dest)) {
          skipped += 1;
          continue; // already archived at this inode
        }
        // Different inode — file was rewritten. Archive new inode alongside old.
        const ino = st.ino;
        const dot = e.lastIndexOf(".");
        const newName = dot > 0
          ? e.slice(0, dot) + `.ino${ino}` + e.slice(dot)
          : e + `.ino${ino}`;
        targetDest = join(destDir, newName);
        if (existsSync(targetDest) && sameFile(full, targetDest)) {
          skipped += 1;
          continue;
        }
      }

      if (dry) {
        linked += 1;
        continue;
      }

      try {
        mkdirSync(destDir, { recursive: true });
        linkSync(full, targetDest);
        linked += 1;
      } catch (e) {
        failed += 1;
        errors.push(`${rel}: ${e.message}`);
      }
    }
  };

  if (isFile(src)) {
    // Store path names a single file (e.g. .ollama/history)
    const e = basename(src);
    const rel = e;
    if (isArchivable(src, rel)) {
      const dest = join(destRoot, e);
      if (existsSync(dest) && sameFile(src, dest)) {
        skipped += 1;
      } else if (!dry) {
        try {
          mkdirSync(destRoot, { recursive: true });
          linkSync(src, dest);
          linked += 1;
        } catch (err) {
          failed += 1;
          errors.push(`${e}: ${err.message}`);
        }
      } else {
        linked += 1;
      }
    } else {
      // A single-file store that links nothing must not report "ok" with three
      // zeros — that is exactly how ~/.ollama/history (4,422 bytes) read as
      // {linked:0, skipped:0, failed:0, status:"ok"} for every tick.
      return { linked: 0, skipped: 0, failed: 0, status: `not archivable: ${e}` };
    }
  } else {
    walk(src, "");
  }

  const status = errors.length > 0
    ? `${errors.length} FAILED (${errors.slice(0, 3).join("; ")})`
    : "ok";
  return { linked, skipped, failed, status };
}

// ---- CLI store map ---------------------------------------------------------
// Where every CLI keeps its sessions. Ported from deadreckon stores.py.
// Used by the archive tick to know what to protect.

function vscodeBase(home) {
  const bases = [];
  if (platform() === "darwin") bases.push(join(home, "Library", "Application Support"));
  else if (platform() === "win32") bases.push(process.env.APPDATA || join(home, "AppData", "Roaming"));
  bases.push(join(home, ".config"));
  const out = [];
  for (const b of bases) {
    for (const ch of ["Code", "Code - Insiders", "VSCodium", "Code - OSS"]) {
      const d = join(b, ch);
      if (isDir(d)) out.push([ch, d]);
    }
  }
  return out;
}

export function allStores(home) {
  home = home ?? homedir();
  const stores = [];
  const add = (label, path) => stores.push({ label, path: join(home, path) });

  // Claude — glob .*claude*/projects
  let topEntries;
  try { topEntries = readdirSync(home); } catch { topEntries = []; }
  for (const e of topEntries) {
    if (e.startsWith(".claude") || e.startsWith(".my-claude") || e.startsWith(".proteus")) {
      const proj = join(home, e, "projects");
      if (isDir(proj)) stores.push({ label: `claude/${e}`, path: proj });
    }
  }

  add("gemini", ".gemini/tmp");
  add("gemini-antigravity", ".gemini/antigravity-cli/conversations");
  add("copilot", ".copilot/session-state");
  add("codex", ".codex/sessions");
  add("codex-archived", ".codex/archived_sessions");
  add("lmstudio", ".lmstudio/conversations");
  add("grok", ".grok/sessions");
  add("grok-archived", ".grok/archived_sessions");
  add("deepseek", ".deepseek/sessions");
  add("cursor", ".cursor/chats");
  // aider's SESSION history, not the whole dotdir. `.aider` was added whole,
  // and whole includes oauth-keys.json, which the archive then hard-linked —
  // credential material duplicated into a tree that is meant to be safe to
  // sync. The chat history is the record; nothing else in that directory is.
  add("aider", ".aider/.aider.chat.history.md");
  add("aider-input", ".aider/.aider.input.history");
  add("continue", ".continue/sessions");
  add("opencode", ".opencode/sessions");
  add("goose", ".config/goose/sessions");
  add("openhands", ".openhands/sessions");
  add("qwen", ".qwen/tmp");
  add("amp", ".amp/threads");
  stores.push({ label: "ollama", path: join(home, ".ollama", "history") });
  stores.push({ label: "bob", path: join(home, ".bob", "db") });

  for (const [ch, vsRoot] of vscodeBase(home)) {
    const gs = join(vsRoot, "User", "globalStorage");
    stores.push({ label: `kilocode/${ch}`, path: join(gs, "kilocode.kilo-code", "tasks") });
    stores.push({ label: `cline/${ch}`, path: join(gs, "saoudrizwan.claude-dev", "tasks") });
    stores.push({ label: `roo/${ch}`, path: join(gs, "rooveterinaryinc.roo-cline", "tasks") });
    stores.push({ label: `copilot-chat/${ch}`, path: join(vsRoot, "User", "workspaceStorage") });
  }

  return stores.filter(s => isDir(s.path) || isFile(s.path));
}

// ---- Public API ------------------------------------------------------------

/**
 * check() — report exposure, change nothing.
 * apply() — apply both layers.
 * tick()  — apply + return a one-line summary string (for daemon log).
 */

// OPTS REACHES THE DISCOVERY, or the injected home is only half honoured.
// findClaudeProfiles takes {configDir} and defaults it to
// $CLAUDE_CONFIG_DIR, which is right for production and wrong for a caller
// that has just built a temp home to ask a question about. check(), apply()
// and needsProtection() passed the home and dropped the option, so on a
// developer machine with CLAUDE_CONFIG_DIR set they answered about a profile
// the caller never mentioned. The three needsProtection tests were green here
// only because this machine's $CLAUDE_CONFIG_DIR happens to point at an
// already-raised profile: set it at a 30-day one and they invert.
export function check(home, opts = {}) {
  home = home ?? homedir();
  const profiles = findClaudeProfiles(home, opts);
  const stores = allStores(home);

  const profileResults = profiles.map(p => ({
    path: p,
    cleanupDays: currentPeriod(p),
    atRisk: currentPeriod(p) < TARGET_DAYS,
    wouldChange: raisePeriod(p, { dry: true }).changed,
  }));

  const storeResults = stores.map(s => ({
    label: s.label,
    path: s.path,
    result: linkTree(s.path, s.label, { home, dry: true }),
  }));

  return { profiles: profileResults, stores: storeResults, dry: true };
}

export function apply(home, opts = {}) {
  home = home ?? homedir();
  const profiles = findClaudeProfiles(home, opts);
  const stores = allStores(home);

  const profileResults = profiles.map(p => ({
    path: p,
    ...raisePeriod(p),
  }));

  const storeResults = stores.map(s => ({
    label: s.label,
    path: s.path,
    result: linkTree(s.path, s.label, { home }),
  }));

  return { profiles: profileResults, stores: storeResults };
}

export function tick(home) {
  const result = apply(home);
  const atRisk = result.profiles.filter(p => p.changed).length;
  const totalLinked = result.stores.reduce((a, s) => a + (s.result.linked ?? 0), 0);
  const totalFailed = result.stores.reduce((a, s) => a + (s.result.failed ?? 0), 0);

  // Three ways this tick can do nothing and still have printed "protect: ok":
  // a raisePeriod write error, a linkTree barrier (cross-filesystem or
  // unwritable archive — barrier returns carry NO `status` key at all), and
  // per-file link errors. All three go in the line, none is a silent zero.
  const failures = [];
  for (const p of result.profiles) {
    if (p.failed) failures.push(`${p.path}: ${p.message}`);
  }
  for (const s of result.stores) {
    if (s.result.barrier) failures.push(`${s.label}: ${s.result.barrier}`);
  }
  if (totalFailed > 0) failures.push(`${totalFailed} file(s) failed to link`);

  const parts = [];
  if (atRisk > 0) parts.push(`raised period on ${atRisk} profile(s)`);
  if (totalLinked > 0) parts.push(`${totalLinked} file(s) archived`);

  if (failures.length > 0) {
    // cli.mjs:400 ends `starreckon protect` with an unconditional
    // process.exit(0), so a plain process.exitCode is discarded. An exit
    // listener is the last write and wins — verified on node v22.21.0. If
    // cli.mjs ever stops hard-coding 0, delete the listener, not the line.
    // It exits the CALLING process: test tick()-with-failures in a subprocess,
    // or `node --test` reports 1 with every assertion passing.
    process.exitCode = 1;
    process.once("exit", () => { process.exitCode = 1; });
    const did = parts.length ? ` (did: ${parts.join(", ")})` : "";
    return `protect: ${failures.length} FAILED — ${failures.join("; ")}${did}`;
  }
  return parts.length ? `protect: ${parts.join(", ")}` : "protect: ok (nothing new)";
}

/**
 * Whether any Claude profile still has cleanupPeriodDays below TARGET_DAYS
 * and the 6h daemon is not installed. Used by cli.mjs to print the warning.
 */
export function needsProtection(home, opts = {}) {
  home = home ?? homedir();
  const profiles = findClaudeProfiles(home, opts);
  return profiles.some(p => currentPeriod(p) < TARGET_DAYS);
}

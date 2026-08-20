// @ts-nocheck
// starreckon user config — ~/.starreckon/config.json
//
// Optional. starreckon works with zero config. This file only exists when the
// user has something non-default to say.
//
// Fields:
//
//   extra_roots   array of strings — additional home directories to scan.
//                 Same as passing --roots on the command line, but persisted.
//                 Use when AI-coding session files live outside the default
//                 home, e.g. a second user account, an external drive, or a
//                 directory pointed to by $CLAUDE_CONFIG_DIR / $CODEX_HOME /
//                 $COPILOT_HOME etc.
//                 Standard locations (everything under ~ at depth ≤ 4) are
//                 found automatically — no entry needed for those.
//
//   api_keys      object — one key per CLI name, value is the API key string.
//                 Optional and additive: the local file scan ALWAYS runs
//                 regardless. An API key only fills in what local files
//                 cannot answer (e.g. which org owns a key-only profile
//                 with no OAuth email on disk).
//                 Supported CLI names: claude, gemini, copilot, codex, grok,
//                 kilocode, lmstudio, antigravity
//
// Example:
//   {
//     "extra_roots": ["/Volumes/OldDrive/Users/me"],
//     "api_keys": { "claude": "sk-ant-..." }
//   }

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KNOWN_CLI_NAMES = new Set([
  "claude", "gemini", "copilot", "codex", "grok",
  "kilocode", "lmstudio", "antigravity",
]);

export function configPath(home) {
  return join(home ?? homedir(), ".starreckon", "config.json");
}

/**
 * Read ~/.starreckon/config.json.
 * Returns a clean object with only the recognised fields.
 * Returns {} when absent or unparseable — never throws.
 */
export function readConfig(home) {
  const file = configPath(home);
  if (!existsSync(file)) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out = {};

  // extra_roots — array of non-empty strings
  if (Array.isArray(raw.extra_roots)) {
    const roots = raw.extra_roots
      .filter(r => typeof r === "string" && r.trim())
      .map(r => r.trim());
    if (roots.length > 0) out.extra_roots = roots;
  }

  // api_keys — object, known CLI names only, non-empty string values
  if (raw.api_keys && typeof raw.api_keys === "object" && !Array.isArray(raw.api_keys)) {
    const keys = {};
    for (const [cli, key] of Object.entries(raw.api_keys)) {
      if (KNOWN_CLI_NAMES.has(cli) && typeof key === "string" && key.trim()) {
        keys[cli] = key.trim();
      }
    }
    if (Object.keys(keys).length > 0) out.api_keys = keys;
  }

  return out;
}

/**
 * Write a config object to ~/.starreckon/config.json.
 * Only recognised fields are written. Unknown keys from manual edits are
 * stripped so the file stays predictable.
 *
 * Deletes the file only when the CALLER passed nothing. An empty object means
 * "I have no configuration", and that is a request to remove it.
 *
 * IT USED TO DELETE WHEN THE FILTER EMPTIED THE RESULT, WHICH IS A DIFFERENT
 * FACT. `if (Object.keys(clean).length === 0) unlinkSync(file)` could not tell
 * "the caller asked for nothing" from "everything the caller asked for was
 * rejected" — and the api_keys filter rejects any name outside
 * KNOWN_CLI_NAMES, which includes `kilo`, the key the reader registry actually
 * uses (scanners.mjs READERS). So writing a key under the one spelling the
 * scanner answers to destroyed the file, taking the user's extra_roots with
 * it. Nothing in production calls this yet, so no user has lost a file; the
 * trap was armed and waiting for the first caller.
 *
 * A write that is rejected now says so and leaves the file alone.
 */
export function writeConfig(home, obj) {
  const file = configPath(home);
  const askedForNothing = !obj || Object.keys(obj).length === 0
    || Object.entries(obj).every(([, v]) =>
      v == null || (Array.isArray(v) ? v.length === 0
                    : typeof v === "object" ? Object.keys(v).length === 0
                    : false));
  const clean = {};

  if (Array.isArray(obj?.extra_roots)) {
    const roots = obj.extra_roots
      .filter(r => typeof r === "string" && r.trim())
      .map(r => r.trim());
    if (roots.length > 0) clean.extra_roots = roots;
  }

  if (obj?.api_keys && typeof obj.api_keys === "object") {
    const keys = {};
    for (const [cli, key] of Object.entries(obj.api_keys)) {
      if (KNOWN_CLI_NAMES.has(cli) && typeof key === "string" && key.trim()) {
        keys[cli] = key.trim();
      }
    }
    if (Object.keys(keys).length > 0) clean.api_keys = keys;
  }

  if (Object.keys(clean).length === 0) {
    if (askedForNothing) {
      if (existsSync(file)) try { unlinkSync(file); } catch { /* best-effort */ }
      return;
    }
    // The caller offered something and none of it survived. Refusing loudly is
    // the only option that is not a lie: writing an empty file would discard
    // their existing config just as thoroughly as unlinking it did.
    throw new Error(
      "writeConfig: nothing in the supplied config was recognised, so it was "
      + "not written and " + file + " was left as it is. Check the CLI names "
      + "in api_keys against KNOWN_CLI_NAMES.");
  }

  mkdirSync(join(home ?? homedir(), ".starreckon"), { recursive: true });
  writeFileSync(file, JSON.stringify(clean, null, 2) + "\n", "utf-8");
}

/**
 * Return the effective roots for a scan: default home + config extra_roots
 * + any CLI-provided roots. Deduplicated.
 */
export function effectiveRoots(cliRoots = [], home = null) {
  const cfg = readConfig(home);
  const all = [home ?? homedir(), ...(cfg.extra_roots ?? []), ...cliRoots];
  const seen = new Set();
  const out = [];
  for (const r of all) {
    const k = r.toLowerCase(); // case-insensitive dedup on macOS/Windows
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}

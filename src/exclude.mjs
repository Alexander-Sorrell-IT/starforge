// Persisted scan exclusions — folder paths or keyword fragments that should
// never be scanned, saved across runs.
//
// Storage: ~/.starreckon/exclude.json. Like contact.json this file is NEVER
// written by a scan or by any automatic process — only by the [E] menu in the
// terminal or by the user editing it directly.
//
// Format: { "paths": ["client-work", "secret-project", "/home/me/private"] }
//
// How they work: each entry is a fragment. A session file path that contains
// the fragment (case-insensitive) is excluded from the scan — same logic as
// the interactive prompt, but loaded before the scan starts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR  = join(homedir(), ".starreckon");
const FILE = join(DIR, "exclude.json");

/** Read persisted exclusions. Returns [] if the file does not exist. */
export function readExclusions() {
  if (!existsSync(FILE)) return [];
  try {
    const d = JSON.parse(readFileSync(FILE, "utf8"));
    return (d.paths ?? []).filter((s) => typeof s === "string" && s.trim());
  } catch {
    return [];
  }
}

/** Write a new exclusions list to disk. */
export function writeExclusions(paths) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ paths: paths.filter(Boolean) }, null, 2));
}

/** Add a fragment (no-op if already present). Returns the new list. */
export function addExclusion(frag) {
  const cur = readExclusions();
  if (cur.some((e) => e.toLowerCase() === frag.toLowerCase())) return cur;
  const next = [...cur, frag.trim()];
  writeExclusions(next);
  return next;
}

/** Remove a fragment by index (0-based). Returns the new list. */
export function removeExclusion(index) {
  const cur = readExclusions();
  const next = cur.filter((_, i) => i !== index);
  writeExclusions(next);
  return next;
}

export { FILE as EXCLUDE_FILE };

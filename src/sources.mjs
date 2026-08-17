// `starreckon sources` — every place AI-coding work can happen, and which of
// them this machine actually has.
//
// It reads spec/sources.json and asks the filesystem. It runs nothing, opens no
// socket, and writes nothing, so it needs no entry in verify.mjs's
// STATIC_ALLOWLIST and adds nothing to PROVE-IT.md's write list.
//
// THE POINT OF THE COMMAND IS THE GAPS, NOT THE INVENTORY.
//
// A source this program cannot count reports `no reader` BY NAME. It never
// reports 0, and it is never simply left out. Those are three different facts:
//
//   not installed   you do not use this tool
//   installed, 0    you use it and it recorded nothing
//   no reader       you use it and NOBODY HERE CAN COUNT IT
//
// The third is invisible in every other view — a tool with no reader
// contributes nothing to a total and looks identical to a tool nobody has. On
// this fleet that is `cursor`, which standout scores and neither program reads.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { walk } from "./discover.mjs";
import { maskPath } from "./redact.mjs";

export function loadSources() {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, "..", "spec", "sources.json");
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    // A missing spec is not "no sources" — it is a broken install, and it says
    // so rather than printing an empty table that reads like an answer.
    throw new Error(
      `cannot read ${file}: ${e.message}. The source list ships with this `
      + `package; an install without it cannot say what it looked for.`);
  }
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const ls = (p) => { try { return readdirSync(p); } catch { return null; } };

/**
 * Expand a `bases` entry from the spec into absolute directories.
 *
 * The spec gives SEGMENT LISTS, never joined strings, so no separator
 * convention has to be agreed between a Python reader and a JavaScript one —
 * join() decides, per platform, at the moment of use.
 */
function expandBase(name, home, spec) {
  const table = spec.bases?.[name];
  if (!table) return [];
  const key = process.platform === "darwin" ? "darwin"
            : process.platform === "win32" ? "win32" : "linux";
  const out = [];
  for (const segs of table[key] ?? []) {
    const parts = segs.map((seg) =>
      seg === "{APPDATA}" ? (process.env.APPDATA || join(home, "AppData", "Roaming")) : seg);
    // An absolute substitution (%APPDATA%) replaces home rather than nesting
    // under it; anything else is home-relative.
    out.push(parts.length && parts[0].includes(sep) ? join(...parts) : join(home, ...parts));
  }
  return out;
}

/**
 * Every directory a declared store could live in, on this machine.
 *
 * THE TWO NON-LITERAL SHAPES ARE RULES WITH NAMES, NOT GLOBS.
 * `dotdir_contains` is "every dotdir under the base whose name contains this
 * word" — the rule that finds ~/.claude, ~/.claude-alt AND ~/.my-claude, where
 * the `.claude*` glob it replaces missed the last one and with it 269,561,229
 * orphan tokens. `channel` is which editor directory a vscode store sits under.
 * Neither is a glob string, because a glob is read differently by Python's glob
 * and Node's fs, and declaring one would move the drift rather than remove it.
 */
export function storePaths(store, home, spec) {
  let roots = expandBase(store.base, home, spec);

  if (store.channel) {
    roots = roots.map((r) => join(r, store.channel)).filter(isDir);
  }
  if (store.dotdir_contains) {
    const word = store.dotdir_contains.toLowerCase();
    const hits = [];
    for (const r of roots) {
      for (const e of (ls(r) ?? []).sort()) {
        if (e.startsWith(".") && e.slice(1).toLowerCase().includes(word)
            && isDir(join(r, e))) hits.push(join(r, e));
      }
    }
    roots = hits;
  }
  const segs = store.segments ?? [];
  return roots.map((r) => (segs.length ? join(r, ...segs) : r));
}

/**
 * Where a source lives on this machine, and whether it can be read.
 *
 * PRESENCE AND READABILITY ONLY — never a count. The reader turns `present`
 * into `empty` or `counted`; this cannot know which without counting, and a
 * function that guesses would be the same collapse it exists to prevent.
 *
 * WHY `searched` COMES BACK. "absent" has to mean *not at any declared path,
 * and here is the list*. Before the paths were declared it meant "not at the
 * one place this reader happens to hardcode", which is how `starreckon sources`
 * reported cowork as `ok` on Linux while the scan never read it — two files
 * disagreeing about where cowork lives.
 *
 * `unreadable` is its own answer and is never folded into `absent` or `empty`.
 * A store that is there and cannot be entered is not a tool nobody uses, and
 * the difference is the single most repeated defect in this system: 28 of the
 * 106 confirmed on 2026-08-16.
 */
export function probe(source, home = homedir(), spec = loadSources()) {
  const searched = [], found = [], unreadable = [];
  for (const store of source.stores ?? []) {
    for (const p of storePaths(store, home, spec)) {
      searched.push(p);
      let st;
      try {
        st = statSync(p);
      } catch (e) {
        // ENOENT is absence. EACCES/EPERM on the path itself is a store that
        // IS there and cannot be looked at.
        if (e.code === "EACCES" || e.code === "EPERM") unreadable.push({ path: p, why: e.code });
        continue;
      }
      if (st.isDirectory()) {
        if (ls(p) === null) { unreadable.push({ path: p, why: "EACCES" }); continue; }
      }
      found.push(p);
    }
  }
  return {
    present: found.length > 0,
    searched, found, unreadable,
    state: found.length ? "present" : (unreadable.length ? "unreadable" : "absent"),
  };
}

/**
 * The four states, decided once. `sessions` is what the reader counted.
 *
 * An unreadable store outranks a count: if part of the store could not be
 * entered, the number is a floor and the caller must be told so rather than
 * shown a total that looks complete.
 */
export function stateOf(pr, sessions) {
  if (pr.unreadable.length) return "unreadable";
  if (!pr.present) return "absent";
  return sessions > 0 ? "counted" : "empty";
}

export function survey(home = homedir()) {
  const spec = loadSources();
  return spec.sources.map((s) => {
    // DECLARED, NOT GUESSED. detectSource() used to infer a path from `kind` —
    // a dotdir for a cli, a rummage under vscode storage for an extension — so
    // it and the scan could reach different conclusions about the same tool.
    // Both now read the same declared stores.
    const pr = probe(s, home, spec);
    const readable = (s.counted_by ?? []).includes("starreckon");
    let state;
    if (s.kind === "derived") state = readable ? "derived" : "no reader";
    else if (!readable) state = "no reader";
    else if (pr.unreadable.length) state = "unreadable";
    else state = pr.present ? "installed" : "not installed";
    return { ...s, ...pr, installed: pr.present, state };
  });
}

export function render(rows, { color = true, undeclared = null } = {}) {
  const B = color ? "\x1b[1m" : "", D = color ? "\x1b[2m" : "",
        Y = color ? "\x1b[33m" : "", R = color ? "\x1b[0m" : "";
  const MARK = { installed: "ok", "not installed": "--", derived: "··", "no reader": "!!" };
  const w = Math.max(...rows.map((r) => r.name.length));
  const L = [`${B}sources${R}  ${D}${rows.length} known · spec/sources.json${R}`, ""];
  for (const r of rows) {
    const gap = r.state === "no reader";
    L.push(`  ${gap ? Y : ""}${MARK[r.state]}${R}  ${r.name.padEnd(w)}  ${D}${r.kind}${R}  ${D}${r.label}${R}`);
    if (gap)
      L.push(`      ${Y}no reader in starreckon — counted by ${(r.counted_by ?? []).join(", ") || "nobody"}${R}`);
  }
  const gaps = rows.filter((r) => r.state === "no reader");
  const blind = rows.filter((r) => r.state === "unreadable");
  L.push("");
  L.push(`  ${D}installed ${rows.filter(r => r.state === "installed").length}`
       + ` · not installed ${rows.filter(r => r.state === "not installed").length}`
       + ` · unreadable ${blind.length}`
       + ` · no reader ${gaps.length}${R}`);
  if (gaps.length)
    L.push(`  ${D}a source with no reader contributes 0 to every total and looks`
         + ` exactly like one you do not use. That is why it is listed.${R}`);

  // AND WHAT IS HERE THAT NOBODY DECLARED. The list above can only ever be as
  // complete as the spec; this is the half that notices a tool the spec has
  // never heard of, rather than waiting for somebody to add it.
  if (undeclared) {
    const news = (undeclared.found ?? []).filter((f) => f.status !== "KNOWN");
    L.push("");
    if (!news.length) {
      L.push(`  ${B}undeclared${R}  ${D}none — every conversational store under your`
           + ` home is covered by spec/sources.json${R}`);
    } else {
      L.push(`  ${B}undeclared${R}  ${Y}${news.length} store-shaped director${news.length === 1 ? "y" : "ies"}`
           + ` nobody declared${R}`);
      for (const f of news.slice(0, 12))
        // MASKED, like every other path this program prints. These come off a
        // walk of the user's home, so they carry the username; `sources` output
        // is the kind of thing that gets pasted into an issue.
        L.push(`    ${f.status === "UNKNOWN" ? Y : D}${f.status.toLowerCase().padEnd(9)}${R} `
             + `${maskPath(f.path)}  ${D}${f.why ?? ""}${R}`);
      if (news.length > 12) L.push(`    ${D}… and ${news.length - 12} more${R}`);
      L.push(`  ${D}a tool here that is not in spec/sources.json is counted by nobody.`
           + ` Add it there to have it read.${R}`);
    }
  }
  return L.join("\n");
}

// ── the other half: tools nobody declared ────────────────────────────────────

/**
 * Store-shaped directories under `home` that no declared source covers.
 *
 * THE SPEC ANSWERS "WHERE IS THE TOOL I KNOW ABOUT". THIS ANSWERS "WHAT IS
 * HERE THAT I DO NOT". Without it the program can only ever look where it was
 * told, so a tool the user installs next month is invisible until somebody
 * edits a file — and invisible in the one way this system must never be, as a
 * silent zero rather than a named gap.
 *
 * `discover.walk` has done this classification since it was written: it walks
 * home to depth 4, decides whether a directory looks conversational by reading
 * a budget of its files, and buckets the result KNOWN / UNKNOWN / AMBIGUOUS.
 * It was imported by NOTHING — `node src/discover.mjs` and nothing else — and
 * its `knownPaths` argument, the thing that makes KNOWN mean anything, was
 * never supplied by a caller. So every run classified everything as UNKNOWN or
 * classified nothing at all.
 *
 * The known set comes from the spec, which is the point of declaring paths: the
 * same declaration that tells the readers where to look tells this what has
 * already been looked at.
 */
export function unknownStores(home = homedir(), spec = loadSources()) {
  const known = [];
  for (const s of spec.sources ?? []) {
    for (const store of s.stores ?? []) {
      // Every path the store COULD occupy, whether or not it exists — a tool
      // that is declared but not installed must not make its own directory
      // look like a discovery when it appears.
      for (const p of storePaths(store, home, spec)) known.push(p);
    }
  }
  return { known, ...walkUnknown(home, known) };
}

// Kept behind a lazy import: discover.mjs is a walker, and a `sources` run that
// only wants the declared list should not pay for loading it.
function walkUnknown(home, known) {
  const res = walk(home, known);
  return { found: res.found ?? [], unreadable: res.unreadableDirs ?? [] };
}

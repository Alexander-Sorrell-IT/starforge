// The data receipt: everything this tool has retained about you, enumerated
// from the files themselves.
//
// "Nothing leaves your machine" is only half an answer, and it is the easier
// half. The kernel proof (PROVE-IT.md §1) closes egress — but a tool that never
// sends a byte can still READ your whole transcript and KEEP it in a file on
// your disk. And the scheduled run makes that sharper: a background scan prints
// its story to a log nobody reads, so "what you saw in the terminal" cannot
// police what it collected.
//
// So this walks ~/.starforge — the complete set of everything starforge retains
// — and reports the VOCABULARY of what is in there: every JSON key path, the
// longest free-text string anywhere, and the size and hash of every file. Not a
// promise that there is no transcript text; the actual list of what there is,
// derived from the bytes on disk, for you to read.
//
// Two properties make this worth trusting more than a sentence in a README:
//   - it reads the files, not the code. A build that started keeping prompt text
//     would show it here, because the string would be in the file.
//   - it covers daemon output too, so a background run is exactly as
//     accountable as one you watched.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

export const DATA_DIR = () => join(homedir(), ".starforge");

// Above this, a string stops being a label/number and starts being prose. Same
// threshold verify.mjs uses for its transcript heuristic, on purpose: two checks
// disagreeing about what counts as "text" would make both useless.
export const TEXT_LIMIT = 400;
const MAX_READ = 4 * 1024 * 1024;

function walk(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    // Symlinks are NOT followed and are reported as such: a link can point
    // outside the data dir, and silently following one would let this receipt
    // vouch for bytes it never actually looked at.
    if (st.isSymbolicLink()) { out.push({ full, symlink: true }); continue; }
    if (st.isDirectory()) walk(full, out, depth + 1);
    else if (st.isFile()) out.push({ full, size: st.size });
  }
  return out;
}

/** Every key path in a JSON value, plus the longest string found and where. */
function inspectJson(value, prefix, keys, strings, depth = 0) {
  if (depth > 12) return;
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") strings.push({ at: prefix, len: value.length, value });
    return;
  }
  if (Array.isArray(value)) {
    // Arrays are summarised by their element shape, not by index — otherwise a
    // 200-entry list produces 200 "key paths" and the vocabulary is unreadable.
    for (const v of value.slice(0, 200)) inspectJson(v, `${prefix}[]`, keys, strings, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k;
    keys.add(path);
    // A KEY can carry data too — models{} is keyed by model id — so keys that
    // look like free text must be caught, not just values.
    if (k.length > 64) strings.push({ at: `${prefix}.<key>`, len: k.length, value: k });
    inspectJson(v, path, keys, strings, depth + 1);
  }
}

/**
 * Collapse map-like key paths to their SHAPE.
 *
 * Objects keyed by data — languages.python, models.claude-opus-5,
 * machines.<your-hostname> — otherwise turn the vocabulary into a list of your
 * values, which is both unreadable (422 entries) and the opposite of the point:
 * a receipt should show the fields, and printing your hostname eleven times
 * makes it worse, not more honest. Any parent with more than three distinct
 * children collapses to `parent.<key>`.
 */
export function collapseMapKeys(keys) {
  const childrenOf = new Map();
  for (const k of keys) {
    const i = k.lastIndexOf(".");
    if (i < 0) continue;
    const parent = k.slice(0, i);
    if (!childrenOf.has(parent)) childrenOf.set(parent, new Set());
    childrenOf.get(parent).add(k.slice(i + 1));
  }
  const mapParents = new Set(
    [...childrenOf.entries()].filter(([, kids]) => kids.size > 3).map(([p]) => p)
  );
  const out = new Set();
  for (const k of keys) {
    let path = k;
    for (const p of mapParents) {
      if (path.startsWith(p + ".")) {
        const rest = path.slice(p.length + 1);
        const dot = rest.indexOf(".");
        path = dot === -1 ? `${p}.<key>` : `${p}.<key>${rest.slice(dot)}`;
      }
    }
    out.add(path);
  }
  return [...out].sort();
}

/** Reader-visible text of markup, so an SVG/HTML is judged on what it shows. */
function visibleText(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the receipt. Pure read — it writes nothing, which matters: a command
 * whose job is to account for what was written must not add to the pile.
 */
export function buildReceipt({ dir = DATA_DIR() } = {}) {
  const root = dir;
  const result = {
    data_dir: root,
    exists: existsSync(root),
    files: [],
    total_bytes: 0,
    key_vocabulary: [],
    longest_text: null,
    skipped: { symlinks: 0, too_large: 0, unreadable: 0, binary: 0 },
    reads: null,
    daemon: null,
  };
  if (!result.exists) return result;

  const keys = new Set();
  const strings = [];

  for (const entry of walk(root)) {
    if (entry.symlink) { result.skipped.symlinks += 1; continue; }
    const rel = relative(root, entry.full);
    if (entry.size > MAX_READ) {
      result.skipped.too_large += 1;
      result.files.push({ path: rel, bytes: entry.size, sha256: null, note: "not read: over 4 MB" });
      result.total_bytes += entry.size;
      continue;
    }
    let buf;
    try { buf = readFileSync(entry.full); } catch { result.skipped.unreadable += 1; continue; }
    result.total_bytes += buf.length;
    const sha256 = createHash("sha256").update(buf).digest("hex");
    if (buf.subarray(0, 8192).includes(0)) {
      result.skipped.binary += 1;
      result.files.push({ path: rel, bytes: buf.length, sha256, note: "binary: not inspected" });
      continue;
    }
    const text = buf.toString("utf8");
    const file = { path: rel, bytes: buf.length, sha256 };
    if (/\.json$/i.test(rel)) {
      try {
        const fileKeys = new Set();
        inspectJson(JSON.parse(text), "", fileKeys, strings);
        for (const k of fileKeys) keys.add(k);
        file.keys = fileKeys.size;
      } catch {
        file.note = "not valid JSON — inspected as text";
        strings.push({ at: rel, len: text.length, value: text });
      }
    } else if (/\.(svg|html?|xhtml|xml)$/i.test(rel)) {
      const vis = visibleText(text);
      file.visible_chars = vis.length;
      // Markup is judged on the longest single run of reader-visible words, not
      // the whole document: a stats page legitimately shows a lot of short
      // labels, and summing them would flag every page as "prose".
      for (const chunk of vis.split(/(?<=[.!?])\s+/))
        strings.push({ at: rel, len: chunk.length, value: chunk });
    } else {
      strings.push({ at: rel, len: text.length, value: text });
    }
    result.files.push(file);
  }

  result.key_vocabulary = collapseMapKeys(keys);

  // Split by WHERE the text is, because the two cases mean opposite things.
  // A .json under snapshots/ or audit/ is stored data: prose there would mean
  // this tool kept your conversation. A .html/.svg report is a rendered VIEW,
  // and it is full of the tool's own labels and captions by design — flagging
  // that is a false alarm that trains you to ignore the real one.
  const isView = (at) => /\.(svg|html?|xhtml|xml)$/i.test(at);
  const dataStrings = strings.filter((s) => !isView(s.at));
  const viewStrings = strings.filter((s) => isView(s.at));
  const top = (list) => list.sort((a, b) => b.len - a.len)[0] ?? null;
  const shape = (s, limit) =>
    s && {
      at: s.at,
      chars: s.len,
      over_limit: s.len > limit,
      sample: s.value.slice(0, 120),
    };
  result.longest_text = shape(top(dataStrings), TEXT_LIMIT);
  result.longest_view_text = shape(top(viewStrings), Infinity);

  // What the most recent run READ, from its own audit log.
  try {
    const auditDir = join(root, "audit");
    const logs = readdirSync(auditDir).filter((f) => /^run-.*\.json$/.test(f)).sort();
    if (logs.length) {
      const last = JSON.parse(readFileSync(join(auditDir, logs[logs.length - 1]), "utf8"));
      result.reads = {
        log: relative(root, join(auditDir, logs[logs.length - 1])),
        by_source: last.reads ?? null,
        writes: (last.writes ?? []).length,
        argv: last.argv ?? null,
        started_at: last.started_at ?? null,
      };
    }
  } catch {}

  // Daemon output is part of the accounting: a background run shows you nothing
  // at the time, so its log has to be findable and countable here.
  try {
    const dDir = join(root, "daemon");
    if (existsSync(dDir)) {
      const files = readdirSync(dDir).map((f) => {
        const p = join(dDir, f);
        let size = 0;
        try { size = statSync(p).size; } catch {}
        return { name: f, bytes: size };
      });
      result.daemon = { dir: relative(root, dDir), files };
    }
  } catch {}

  return result;
}

const B = "\x1b[1m", D = "\x1b[2m", C = "\x1b[36m", G = "\x1b[32m", Y = "\x1b[33m", RS = "\x1b[0m";

export function renderReceipt(r, { color = true } = {}) {
  const c = (code, s) => (color ? `${code}${s}${RS}` : s);
  const out = [];
  out.push(c(B + C, "starforge receipt") + c(D, " — everything this tool has kept about you"));
  out.push("");
  if (!r.exists) {
    out.push("no data directory yet — nothing has been retained.");
    return out.join("\n");
  }
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  out.push(`${c(B, "where")}      ${r.data_dir.replace(homedir(), "~")}`);
  out.push(`${c(B, "retained")}   ${r.files.length} file(s), ${kb(r.total_bytes)} total`);
  if (r.reads) {
    const by = r.reads.by_source ?? {};
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    out.push(`${c(B, "last run")}   read ${total} log file(s) [${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ")}], wrote ${r.reads.writes}`);
    if (r.reads.argv) out.push(`${c(D, "           argv: " + (Array.isArray(r.reads.argv) ? r.reads.argv.join(" ") : r.reads.argv))}`);
  }
  out.push("");
  out.push(c(B, "longest free text in STORED DATA (snapshots, audit, reports json)"));
  if (!r.longest_text) out.push("  " + c(G, "none — the stored data contains no readable prose at all"));
  else {
    const t = r.longest_text;
    out.push(
      "  " +
        (t.over_limit
          ? c(Y, `${t.chars} chars — OVER the ${TEXT_LIMIT}-char limit. INSPECT THIS.`)
          : c(G, `${t.chars} chars — under the ${TEXT_LIMIT}-char limit`))
    );
    out.push(`  ${c(D, `in ${t.at}: "${t.sample}${t.chars > 120 ? "…" : ""}"`)}`);
  }
  out.push(`  ${c(D, "if this tool were keeping your prompts, they would be here.")}`);
  if (r.longest_view_text) {
    out.push("");
    out.push(c(B, "longest text in a RENDERED VIEW (svg/html you asked it to write)"));
    out.push(`  ${c(D, `${r.longest_view_text.chars} chars in ${r.longest_view_text.at}`)}`);
    out.push(`  ${c(D, "a report page is mostly this tool's own labels and captions, so a")}`);
    out.push(`  ${c(D, "long run here is expected — it is a view, not a store. read it")}`);
    out.push(`  ${c(D, "before you share it: it carries your project names by design.")}`);
  }
  out.push("");
  out.push(c(B, `every field it stores (${r.key_vocabulary.length} distinct fields)`));
  out.push(c(D, "  <key> means an object keyed by your data — model ids, languages,"));
  out.push(c(D, "  machine names — collapsed to its shape rather than listing values."));
  // A few field paths are very long. Truncate for DISPLAY only so the list
  // stays two columns and readable; --json carries every path in full.
  const MAXK = 36, colw = MAXK + 2;
  const shown = r.key_vocabulary.map((k) => (k.length > MAXK ? k.slice(0, MAXK - 1) + "…" : k));
  for (let i = 0; i < shown.length; i += 2)
    out.push("  " + c(D, shown.slice(i, i + 2).map((k) => k.padEnd(colw)).join("").trimEnd()));
  out.push("");
  if (r.daemon) {
    out.push(c(B, "scheduled runs"));
    if (!r.daemon.files.length) out.push(c(D, "  no background run has written output yet"));
    for (const f of r.daemon.files)
      out.push(`  ${c(D, `${f.name} — ${kb(f.bytes)} (a background run prints here; read it)`)}`);
    out.push("");
  }
  const sk = r.skipped;
  if (sk.symlinks || sk.too_large || sk.unreadable || sk.binary) {
    out.push(c(B, "not inspected"));
    if (sk.symlinks) out.push(c(D, `  ${sk.symlinks} symlink(s) — not followed; a link can point outside this dir`));
    if (sk.too_large) out.push(c(D, `  ${sk.too_large} file(s) over 4 MB — hashed and sized, not read`));
    if (sk.binary) out.push(c(D, `  ${sk.binary} binary file(s)`));
    if (sk.unreadable) out.push(c(D, `  ${sk.unreadable} unreadable file(s)`));
    out.push("");
  }
  out.push(c(D, "this is derived from the bytes on your disk, not from what the code"));
  out.push(c(D, "claims. it accounts for what was KEPT; the kernel proof accounts for"));
  out.push(c(D, "what was SENT. you need both, and neither is this tool's word:"));
  out.push(`  ${c(C, "starforge-cli prove")}${c(D, "   the egress half, run by you")}`);
  return out.join("\n");
}

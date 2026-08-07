// The data receipt.
//
// The kernel proof answers "did anything leave?". This answers the other half —
// "is it keeping more than it showed me?" — and the two are independent: a tool
// that never opens a socket can still read your whole transcript and park it in
// a file. The scheduled run sharpens it, because a background scan prints to a
// log nobody watches, so what you saw in the terminal cannot account for it.
//
// The test that matters most is the last one: plant prompt text in the data dir
// and require the receipt to surface it. A disclosure tool that cannot detect
// the thing it exists to disclose is worse than none, because it reassures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReceipt, renderReceipt, collapseMapKeys, TEXT_LIMIT } from "../src/receipt.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sf-receipt-"));
  mkdirSync(join(dir, "snapshots"), { recursive: true });
  mkdirSync(join(dir, "audit"), { recursive: true });
  writeFileSync(
    join(dir, "snapshots", "2026-08.json"),
    JSON.stringify({
      month: "2026-08",
      machines: {
        "some-host": { sessions: 12, duration_hours: 3.5, languages: { js: 4, py: 2 } },
      },
    })
  );
  writeFileSync(
    join(dir, "audit", "run-2026-08-01T00-00-00.000Z.json"),
    JSON.stringify({
      started_at: "2026-08-01T00:00:00.000Z",
      reads: { claude_code: 10, codex: 2 },
      writes: [{ path: "~/.starforge/snapshots/2026-08.json", sha256: "ab", bytes: 100 }],
      argv: ["--yes"],
    })
  );
  return dir;
}

test("the receipt enumerates the files and fields actually on disk", (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = buildReceipt({ dir });
  assert.equal(r.exists, true);
  assert.equal(r.files.length, 2);
  for (const f of r.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, "every inspected file must be hashed");
    assert.ok(f.bytes > 0);
  }
  assert.ok(r.total_bytes > 0);
  assert.ok(r.key_vocabulary.includes("month"));
  assert.ok(r.key_vocabulary.includes("reads"));
  // It reports what the last run READ, not just what it wrote.
  assert.deepEqual(r.reads.by_source, { claude_code: 10, codex: 2 });
});

test("map-like keys collapse to their shape instead of listing your values", () => {
  // Otherwise the "fields" list is really a list of your hostnames, model ids
  // and languages — unreadable, and the opposite of what a receipt is for.
  const keys = new Set([
    "machines", "machines.laptop-a", "machines.laptop-a.sessions",
    "machines.desk-b", "machines.desk-b.sessions",
    "machines.old-mini", "machines.old-mini.sessions",
    "machines.spare", "machines.spare.sessions",
    "active_days",
  ]);
  const out = collapseMapKeys(keys);
  assert.ok(out.includes("machines.<key>"), `expected a collapsed shape, got ${out.join(",")}`);
  assert.ok(out.includes("machines.<key>.sessions"));
  assert.ok(out.includes("active_days"), "ordinary fields must survive untouched");
  for (const k of out) assert.doesNotMatch(k, /laptop-a|desk-b|old-mini/, `a real value leaked into the field list: ${k}`);
  // Three or fewer children is a real object, not a map, and must NOT collapse.
  const small = collapseMapKeys(new Set(["tokens", "tokens.input", "tokens.output"]));
  assert.ok(small.includes("tokens.input"), "a genuine object must keep its field names");
});

test("stored data and rendered views are judged separately", (t) => {
  // A report page is mostly this tool's own labels; flagging that as prose is a
  // false alarm that trains you to ignore the real one.
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "reports"), { recursive: true });
  writeFileSync(
    join(dir, "reports", "stats.html"),
    `<html><body><p>${"a caption about how you drive the machine. ".repeat(60)}</p></body></html>`
  );
  const r = buildReceipt({ dir });
  assert.ok(r.longest_view_text, "the view's text must be reported");
  assert.ok(r.longest_view_text.at.endsWith(".html"));
  assert.equal(r.longest_text.over_limit, false, "a long VIEW must not flag the stored-data verdict");
});

test("planted prompt text in stored data is surfaced, not missed", (t) => {
  // The whole point. If this ever fails, the receipt is reassuring people about
  // a property it can no longer detect.
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript =
    "can you refactor the billing module before the audit lands, and also check " +
    "whether the invoice totals reconcile with what the vendor sent us last quarter, " +
    "because if they do not we need to raise it before the board meeting on friday " +
    "and I would rather not be the one explaining that in the room without numbers. " +
    "while you are in there, the retry logic around the payment webhook has been " +
    "swallowing errors and I suspect that is why the reconciliation drifts at month " +
    "end, so please check whether a failed callback is being marked settled anyway.";
  assert.ok(transcript.length > TEXT_LIMIT, "the fixture must exceed the limit to be a real test");
  writeFileSync(join(dir, "snapshots", "leak.json"), JSON.stringify({ month: "2026-09", prompt: transcript }));

  const r = buildReceipt({ dir });
  assert.equal(r.longest_text.over_limit, true, "a stored transcript must trip the limit");
  assert.ok(r.longest_text.chars >= transcript.length);
  assert.match(r.longest_text.at, /prompt/, "it must name the field holding the text");

  const rendered = renderReceipt(r, { color: false });
  assert.match(rendered, /OVER the \d+-char limit/, "the rendered receipt must say so out loud");
  assert.match(rendered, /INSPECT THIS/);
});

test("symlinks are counted and never followed", (t) => {
  // Following one would let the receipt vouch for bytes outside the data dir.
  const dir = fixture();
  const outside = mkdtempSync(join(tmpdir(), "sf-outside-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(outside, "secret.json"), JSON.stringify({ not_ours: "x".repeat(900) }));
  symlinkSync(join(outside, "secret.json"), join(dir, "link.json"));

  const r = buildReceipt({ dir });
  assert.equal(r.skipped.symlinks, 1, "the symlink must be counted");
  assert.ok(!r.key_vocabulary.includes("not_ours"), "a symlinked file must not be inspected");
  assert.match(renderReceipt(r, { color: false }), /symlink\(s\) — not followed/);
});

test("the receipt writes nothing", (t) => {
  // A command whose job is accounting for writes must not add to the pile.
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = buildReceipt({ dir });
  buildReceipt({ dir });
  const after = buildReceipt({ dir });
  assert.equal(after.files.length, before.files.length);
  assert.equal(after.total_bytes, before.total_bytes);
  assert.deepEqual(after.files.map((f) => f.sha256), before.files.map((f) => f.sha256));
});

test("a machine with no data dir says so rather than crashing", () => {
  const r = buildReceipt({ dir: join(tmpdir(), "sf-does-not-exist-" + Date.now()) });
  assert.equal(r.exists, false);
  assert.match(renderReceipt(r, { color: false }), /nothing has been retained/);
});

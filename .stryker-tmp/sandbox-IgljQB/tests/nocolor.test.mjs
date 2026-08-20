// @ts-nocheck
// NO_COLOR must mean NO colour — across the whole run, not per renderer.
//
// The star honoured it, the emblem headings honoured it, the receipt honoured
// it. The CARDS did not: they build escape codes into the strings themselves,
// so `--no-pace > wrapped.txt` produced a file of escape codes and every capture
// for the submission folder had to be piped through sed to be readable.
//
// The test that matters is therefore end-to-end. A unit test on box() would have
// passed while the banner, the summary, the fleet rollup, the QR and the pager
// counter all still emitted colour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ESC = /\x1b\[/;

function corpus() {
  const home = mkdtempSync(join(tmpdir(), "sf-nc-"));
  const dir = join(home, ".claude", "projects", "-w-a");
  mkdirSync(dir, { recursive: true });
  const rows = [];
  for (const mo of ["06", "07"])
    for (let d = 0; d < 5; d++) {
      const ts = `2026-${mo}-${String(10 + d).padStart(2, "0")}T15:00:00.000Z`;
      rows.push({ type: "user", cwd: "/w/a", timestamp: ts, uuid: `u${mo}${d}`,
        message: { role: "user", content: "a prompt long enough to be counted" } });
      rows.push({ type: "assistant", timestamp: ts, uuid: `m${mo}${d}`,
        message: { role: "assistant", id: `msg_${mo}${d}`, model: "claude-opus-5",
          content: [{ type: "tool_use", name: "Bash", input: { file_path: "/w/a/x.py" } }],
          usage: { input_tokens: 900000, output_tokens: 40000,
            cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } });
    }
  writeFileSync(join(dir, "s.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
  return home;
}

const run = (home, args, env = {}) =>
  spawnSync(process.execPath, [join(ROOT, "src", "cli.mjs"), "--yes", ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, TZ: "America/Chicago", ...env },
  });

test("NO_COLOR: a full wrapped run emits not one escape sequence", () => {
  const r = run(corpus(), ["--no-pace"], { NO_COLOR: "1" });
  assert.equal(r.status, 0, r.stderr);
  const bad = r.stdout.split("\n").filter((l) => ESC.test(l));
  assert.deepEqual(
    bad.slice(0, 3), [],
    `${bad.length} line(s) still carry colour under NO_COLOR — first: ${JSON.stringify(bad[0])}`
  );
});

test("NO_COLOR: the cards still draw, they are not merely blanked", () => {
  // Stripping colour must not strip content. A frame with nothing in it would
  // pass the escape-code check perfectly.
  const out = run(corpus(), ["--no-pace"], { NO_COLOR: "1" }).stdout;
  for (const marker of [/FORGED/, /HOW IT WAS SCORED/, /YOUR FORGE RANK/, /SEND IT/, /╭─+╮/])
    assert.match(out, marker, `${marker} is missing from the plain-text run`);
});

test("NO_COLOR: the box frame stays square once the colour is gone", () => {
  // The frame characters were interleaved with resets; dropping them naively
  // can leave rows a character short.
  const out = run(corpus(), ["--no-pace"], { NO_COLOR: "1" }).stdout;
  const widths = new Set(
    out.split("\n").filter((l) => l.startsWith("│") || l.startsWith("╭") || l.startsWith("╰"))
      .map((l) => [...l].length)
  );
  assert.equal(widths.size, 1, `card rows have ragged widths: ${[...widths].join(", ")}`);
});

test("without NO_COLOR the run is still coloured", () => {
  // The inverse, so a future "fix" cannot make colour unconditional.
  const out = run(corpus(), ["--no-pace"], { NO_COLOR: "", FORCE_COLOR: "1" }).stdout;
  assert.ok(out.split("\n").some((l) => ESC.test(l)), "colour disappeared entirely");
});

test("NO_COLOR reaches the star modes and their headings too", () => {
  const out = run(corpus(), ["--dual"], { NO_COLOR: "1" }).stdout;
  assert.doesNotMatch(out, ESC, "the star-only output must be plain as well");
  assert.match(out, /★ this month/, "and must still be labelled");
});

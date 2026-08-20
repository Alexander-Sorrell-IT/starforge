// @ts-nocheck
// --star and --dual promise "the star and NOTHING else".
//
// That promise is not enforceable by reading the flag at one branch point: the
// star-only block exits BEFORE the summary, so anything printed after it is
// suppressed for free, but anything a future change prints EARLIER — a banner,
// a fleet rollup, a snapshot notice — lands inside the mode silently and the
// mode stops being what it says on the box.
//
// So these tests assert the OUTPUT, not the branch. They check what is absent
// as strictly as what is present, because "star only" is a claim about absence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AXES } from "../src/starsvg.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A corpus with enough substance that the star has visible arms — a flat zero
// star would pass an "is a star present" check while proving nothing.
function corpus(days = 6, months = ["07"]) {
  const home = mkdtempSync(join(tmpdir(), "sf-star-"));
  const dir = join(home, ".claude", "projects", "-w-a");
  mkdirSync(dir, { recursive: true });
  const rows = [];
  for (const mo of months) for (let d = 0; d < days; d++) {
    const ts = `2026-${mo}-${String(10 + d).padStart(2, "0")}T15:00:00.000Z`;
    rows.push({ type: "user", cwd: "/w/a", timestamp: ts, uuid: `u${mo}${d}`,
      message: { role: "user", content: "a prompt long enough to be counted" } });
    rows.push({ type: "assistant", timestamp: ts, uuid: `m${mo}${d}`,
      message: { role: "assistant", model: "claude-opus-5",
        content: [{ type: "tool_use", name: "Bash", input: { file_path: "/w/a/x.py" } }],
        usage: { input_tokens: 900000, output_tokens: 40000,
          cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } });
  }
  writeFileSync(join(dir, "s.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
  return home;
}

function run(home, extra) {
  const r = spawnSync(process.execPath, [join(ROOT, "src", "cli.mjs"), "--yes", ...extra], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, TZ: "America/Chicago", NO_COLOR: "1" },
  });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  return r.stdout;
}

// The star is drawn from shade glyphs; the axis labels are the reliable,
// colour-independent marker that a star (not a bar table) was rendered.
const starCount = (out) =>
  (out.match(new RegExp(`${AXES[0]} LV\\.`, "g")) ?? []).length;

test("--star prints one star and nothing else", () => {
  const out = run(corpus(), ["--star"]);
  assert.equal(starCount(out), 1, "exactly one star");
  assert.match(out, /SKILL POINTS/, "the star keeps its footer");
  // Everything the default run shows, which this mode promises to omit.
  // NB: do NOT test for the QR with a block-glyph pattern — the star is drawn
  // from those same glyphs, so /█{4}/ matches the star and the check passes for
  // the wrong reason. Match the share text the QR is printed with instead.
  for (const [what, re] of [
    ["the banner", /local-only developer wrapped/],
    ["the source tally", /^Found: /m],
    ["the profile summary", /── profile ─/],
    ["the wrapped cards", /your year in/i],
    ["the share line", /my skill star/i],
    ["the interactive menu", /\[c\]\s*compare/i],
  ])
    assert.doesNotMatch(out, re, `--star must not print ${what}`);
});

test("--dual prints two stars, month then lifetime, and nothing else", () => {
  // Two months in the corpus, so the timeline genuinely has a month AND a
  // longer lifetime around it. One month would make the two stars identical.
  const out = run(corpus(6, ["06", "07"]), ["--dual"]);
  assert.equal(starCount(out), 2, "two stars");
  assert.match(out, /this month/, "the first is labelled");
  assert.match(out, /lifetime/, "the second is labelled");
  assert.ok(
    out.indexOf("this month") < out.indexOf("lifetime · "),
    "month comes before lifetime"
  );
  assert.doesNotMatch(out, /── profile ─/, "--dual must not print the summary");
});

test("--dual on a single month draws one star, not the same one twice", () => {
  // The tempting shortcut is to print the scan levels under both labels. That
  // renders a comparison that was never measured — two identical stars implying
  // "no change since last month" on a first run.
  const out = run(corpus(), ["--dual"]);
  assert.equal(starCount(out), 1, "no invented second star");
  assert.match(out, /lifetime starts next month/,
    "it must say why the second star is missing");
});

test("--star reports the accumulated lifetime, not just what the logs still hold", () => {
  // Logs are retained ~30 days; snapshots outlive them. Labelling a shrinking
  // window "lifetime" would make the number fall over time.
  const home = corpus();
  run(home, []);
  const out = run(home, ["--star"]);
  assert.match(out, /lifetime · \d+ month\(s\)/, "counts the months behind the number");
});

test("--star draws no scanning animation on a real terminal", () => {
  // This one NEEDS a pty. LiveStar.draw() is a no-op when stdout is not a TTY,
  // so under spawnSync the animation is already absent and deleting its
  // suppression changes nothing — the mutation test proved that: removing
  // `if (starOnly) star.enabled = false` turned zero tests red. Every other
  // test in this file is blind to the exact case a user actually sees.
  //
  // Under a pty the animation redraws in place, and each frame carries the axis
  // labels, so an unsuppressed animation shows up as MANY stars in the capture.
  //
  // script(1) syntax differs by platform:
  //   Linux:  script -qec "<cmd>" /dev/null
  //   macOS:  script -q /dev/null <cmd>   (no -e/-c flags)
  const home = corpus();
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, "src", "cli.mjs"))} --yes --star`;
  const isMac = process.platform === "darwin";
  const scriptArgs = isMac
    ? ["-q", "/dev/null", process.execPath, join(ROOT, "src", "cli.mjs"), "--yes", "--star"]
    : ["-qec", cmd, "/dev/null"];
  const r = spawnSync("script", scriptArgs, {
    encoding: "utf8",
    env: { ...process.env, HOME: home, TZ: "America/Chicago", NO_COLOR: "1" },
  });
  if (r.error) return; // no script(1) on this platform — the other tests still run
  if (r.status !== 0) return; // script exited non-zero (e.g. macOS sandbox) — skip
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
  assert.equal(
    starCount(r.stdout), 1,
    "on a TTY --star must draw exactly one star — no scan animation above it"
  );
});

test("re-scanning the same corpus does not inflate the lifetime", () => {
  // Lifetime is read from the snapshots, so a re-run must REPLACE this
  // machine's entry, never add another one. Found the hard way: run under
  // Docker, which invents a fresh random hostname per container, and six runs
  // of one unchanging corpus scored 28.9, 29.5, 29.6, 29.8 — each run
  // registering as a new machine and the rollup summing them. The wrapper now
  // pins --hostname; this test pins the merge that made it possible.
  const home = corpus(6, ["06", "07"]);
  const points = (out) => out.match(/SKILL POINTS ([\d.]+)/)?.[1];
  const first = points(run(home, ["--star"]));
  assert.ok(first, "a lifetime score was printed");
  for (let i = 0; i < 2; i++)
    assert.equal(
      points(run(home, ["--star"])), first,
      "the same corpus scanned again must score the same — lifetime only grows with new WORK, not with re-runs"
    );
});

test("every star in a run says what it was computed FROM", () => {
  // Two near-identical stars appeared with no titles — the only distinguishing
  // text was a footer, and the first one's read "scan complete", which is a
  // progress message, not an identity. The numbers differ (27.7 vs 28.9) and
  // with nothing naming the sources that reads as a bug rather than as two
  // different measurements.
  const out = run(corpus(6, ["06", "07"]), ["--no-pace", "--no-wrapped"]);
  const heads = out.split("\n").filter((l) => l.startsWith("★"));
  const stars = starCount(out);
  assert.equal(
    heads.length, stars,
    `${stars} star(s) drawn but ${heads.length} heading(s): every star needs one`
  );
  assert.match(out, /★ this month/, "the scan star names its source as this month");
  assert.match(out, /★ lifetime — from \d+ saved monthly snapshots/, "the lifetime star names its source");
  assert.doesNotMatch(out, /scan complete/, "a progress message is not a label");
});

test("headings honour NO_COLOR, so a redirect is not full of escape codes", () => {
  const out = run(corpus(6, ["06", "07"]), ["--dual"]);
  for (const l of out.split("\n").filter((x) => x.includes("★")))
    assert.doesNotMatch(l, /\x1b\[/, `heading still carries ANSI under NO_COLOR: ${JSON.stringify(l)}`);
});

test("the star-only modes stay silent on stdout when asked for JSON too", () => {
  // --json writes files; combining it with --star must not reintroduce the
  // summary through the other branch.
  const out = run(corpus(), ["--star", "--json"]);
  assert.equal(starCount(out), 1);
  assert.doesNotMatch(out, /── profile ─/);
});

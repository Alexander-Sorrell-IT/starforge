// scan.mjs and profile.mjs must agree, because they read the same events.
//
// They are two implementations of overlapping logic living in one process and
// writing into ONE json file, and every divergence found so far has been a bug
// that shipped:
//
//   - the local-clock day key landed in scan.mjs only, so a Chicago user
//     working 10:00 and 20:00 on a single day got active_days 1 from one half
//     and 2 from the other, in the same report, with the inflated number
//     feeding proficiency.consistency
//   - the model shape check landed in scan.mjs only, so `models` carried
//     `proj-<hash>` while `model_sessions` carried a raw filesystem path that
//     went on to the HTML page
//
// Neither was caught, because nothing compared the two halves. This file does.
// It is deliberately about AGREEMENT rather than values: if both are wrong in
// the same way that is a different test's job, but they must never contradict
// each other inside one document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = () => mkdtempSync(join(tmpdir(), "sf-agree-"));

// Timestamps that fall on ONE local day in a US timezone but TWO UTC dates:
// 10:00 and 20:00 America/Chicago = 15:00Z and 01:00Z-the-next-day.
const SAME_LOCAL_DAY = ["2026-07-15T15:00:00.000Z", "2026-07-16T01:00:00.000Z"];

function corpus(home, stamps = SAME_LOCAL_DAY, model = "claude-opus-5") {
  const dir = join(home, ".claude", "projects", "-w-a");
  mkdirSync(dir, { recursive: true });
  const rows = [];
  stamps.forEach((ts, i) => {
    rows.push({ type: "user", cwd: "/w/a", timestamp: ts, uuid: `u${i}`,
      message: { role: "user", content: "a prompt long enough to be counted" } });
    rows.push({ type: "assistant", timestamp: ts, uuid: `m${i}`,
      message: { role: "assistant", model,
        content: [{ type: "tool_use", name: "Bash" }],
        usage: { input_tokens: 100, output_tokens: 50,
          cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } });
  });
  writeFileSync(join(dir, "s.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
  return home;
}

function report(home, tz) {
  const r = spawnSync(process.execPath,
    [join(ROOT, "src", "cli.mjs"), "--yes", "--no-pace", "--json", "--profile"],
    { encoding: "utf8", env: { ...process.env, HOME: home, TZ: tz, NO_COLOR: "1" } });
  const dir = join(home, ".starforge", "reports");
  const f = readdirSync(dir).find((n) => n.startsWith("expanded-"));
  assert.ok(f, `no report: ${r.stdout}${r.stderr}`);
  return JSON.parse(readFileSync(join(dir, f), "utf8"));
}

for (const tz of ["America/Chicago", "Asia/Tokyo", "UTC"]) {
  test(`scan and profile agree on active days and streak in ${tz}`, () => {
    const d = report(corpus(tmp()), tz);
    const cad = d.profile.cadence;
    assert.equal(
      cad.active_days, d.active_days,
      `${tz}: scan says ${d.active_days} active days, profile says ${cad.active_days} — one report, two answers`
    );
    assert.equal(
      cad.longest_streak_days, d.longest_streak_days,
      `${tz}: streak disagrees — ${d.longest_streak_days} vs ${cad.longest_streak_days}`
    );
  });
}

test("two events on one local day are one active day, not two", () => {
  // The exact failure: UTC saw 2026-07-15 and 2026-07-16 and counted a day the
  // user never worked.
  const d = report(corpus(tmp()), "America/Chicago");
  assert.equal(d.active_days, 1, "one local day");
  assert.deepEqual(d.profile.rhythm.active_days, ["2026-07-15"], "no invented day");
});

test("scan and profile agree on the model vocabulary", () => {
  // A MALFORMED model on purpose. With a well-formed id like "claude-opus-5"
  // both halves pass it through unchanged, so the test would go green with the
  // shape check deleted — which is exactly how this divergence survived. The
  // bug only shows when the field is something a model id never is.
  const d = report(corpus(tmp(), SAME_LOCAL_DAY, "/home/someone/private/models"), "UTC");
  const scanModels = Object.keys(d.models ?? {});
  const profModels = Object.keys(d.profile.models?.model_sessions ?? {});
  assert.deepEqual(
    [...profModels].sort(), [...scanModels].sort(),
    "the two halves disagree about which models were used"
  );
  // And neither may carry the raw value: it reached the HTML page once.
  for (const m of [...scanModels, ...profModels])
    assert.doesNotMatch(m, /^\//, `a filesystem path is being reported as a model: ${m}`);
});

// ---- the streak walk, in real timezones ------------------------------------
//
// These exist because the only thing catching a broken streak walk was a grep
// for `toISOString().slice(0, 10)` in the source. A grep is a proxy: writing
// the same UTC key a different way — getUTCFullYear(), a template literal —
// slips past it silently. It also let a REAL bug through, one introduced while
// fixing this very file: the walk parsed "today" with Date.parse (UTC midnight)
// and read it back with localDayKey (local), so west of Greenwich it started a
// day early. In every Americas timezone a user active TODAY scored a current
// streak of 0, and a three-day run scored 2. UTC and every eastern zone were
// fine, which is why nothing noticed.
for (const tz of ["UTC", "America/Chicago", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Auckland"]) {
  test(`current streak counts today and yesterday correctly in ${tz}`, async () => {
    process.env.TZ = tz;
    const { computeStreaks } = await import(`../src/profile.mjs?tz=${tz}`);
    assert.equal(
      computeStreaks(["2026-07-15"], "2026-07-15").current, 1,
      `${tz}: active today must be a current streak of 1`
    );
    const run = computeStreaks(["2026-07-13", "2026-07-14", "2026-07-15"], "2026-07-15");
    assert.equal(run.current, 3, `${tz}: three consecutive days ending today`);
    assert.equal(run.longest, 3, `${tz}: longest run is three`);
    assert.equal(
      computeStreaks(["2026-07-13", "2026-07-15"], "2026-07-15").current, 1,
      `${tz}: a gap yesterday leaves only today`
    );
    assert.equal(
      computeStreaks(["2026-07-14"], "2026-07-15").current, 0,
      `${tz}: active yesterday but not today is a broken streak`
    );
  });
}

test("the day key helper is imported, not reimplemented", () => {
  // The root cause is duplication, so this asserts the duplication is gone: a
  // second copy of localDayKey is a copy that will be fixed once.
  const src = readFileSync(join(ROOT, "src", "profile.mjs"), "utf8");
  assert.match(src, /import \{[^}]*localDayKey[^}]*\} from "\.\/scan\.mjs"/,
    "profile.mjs must import the day-key helper from scan.mjs");
  assert.doesNotMatch(src, /toISOString\(\)\.slice\(0, 10\)/,
    "a UTC day key is back in profile.mjs — it must use the local clock like scan.mjs");
});

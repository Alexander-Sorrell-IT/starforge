// The snapshot file is the only durable record: logs age off after ~30 days,
// so anything the snapshots do not hold is gone. Two ways that guarantee was
// broken, both found on a real run, both pinned here.
//
//   1. writeSnapshots() assigned the current scan straight into
//      machines[host], REPLACING the stored month. One month re-scanned after
//      its logs rotated went 18,000,000 -> 3,600,000 input tokens, in a file
//      whose printed line says "lifetime only ever grows".
//   2. SNAP_DIR came from os.homedir(), which returns $HOME verbatim — and a
//      literal "~" in $HOME made the path "~/.starreckon/snapshots": mkdir
//      ENOENT on an npx run, or, where cwd was writable, a literal "~"
//      directory beside the caller that loadTimeline() never looks in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, hostname, userInfo } from "node:os";
import { join } from "node:path";

// A bucket in the shape scan.mjs's finalize() produces (scan.mjs:686).
function bucket(over = {}) {
  return {
    month: "2026-07",
    sessions: 40,
    duration_hours: 50.5,
    input_tokens: 18_000_000,
    output_tokens: 900_000,
    cache_tokens: 7_000_000,
    tool_calls: 1200,
    languages: { python: 300, rust: 40 },
    models: { "claude-opus-5": 200 },
    projects_count: 9,
    hour_buckets: new Array(24).fill(0).map((_, h) => (h === 3 ? 500 : 10)),
    active_days: 20,
    longest_streak_days: 7,
    ...over,
  };
}

// SNAP_DIR is resolved from homedir() at module load, so each fake HOME needs
// its own module instance — same trick as compare.test.mjs:52.
async function withHome(home) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await import(`../src/snapshots.mjs?t=${Date.now()}${Math.random()}`);
  } finally {
    process.env.HOME = prev;
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), "sf-snap-"));
const readMonth = (home, month, host = hostname()) =>
  JSON.parse(readFileSync(join(home, ".starreckon", "snapshots", `${month}.json`), "utf-8"))
    .machines[host];

// Silence the "kept the stored value" warning where the test is asserting the
// numbers rather than the notice, and hand back what was written to stderr.
async function captureWarn(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(" "));
  try { await fn(); } finally { console.warn = orig; }
  return lines.join("\n");
}

// ---- 1: a smaller re-scan must not shrink the file -------------------------

test("a re-scan that sees less than the snapshot cannot shrink it", async () => {
  const home = tmp();
  const { writeSnapshots } = await withHome(home);
  writeSnapshots([bucket()]);
  // 80% of the transcripts have aged off disk since the first run.
  await captureWarn(() =>
    writeSnapshots([bucket({
      sessions: 8,
      duration_hours: 10.1,
      input_tokens: 3_600_000,
      output_tokens: 180_000,
      cache_tokens: 1_400_000,
      tool_calls: 240,
      languages: { python: 60 },
      models: { "claude-opus-5": 40 },
      projects_count: 2,
      hour_buckets: new Array(24).fill(0).map((_, h) => (h === 3 ? 100 : 2)),
      active_days: 4,
      longest_streak_days: 2,
    })])
  );
  const m = readMonth(home, "2026-07");
  assert.equal(m.input_tokens, 18_000_000, "the measured regression: 18,000,000 -> 3,600,000");
  assert.equal(m.sessions, 40);
  assert.equal(m.duration_hours, 50.5, "floats survive too — duration_hours is not an integer");
  assert.equal(m.tool_calls, 1200);
  assert.equal(m.active_days, 20);
  assert.equal(m.longest_streak_days, 7);
  // Per key and per bucket, not just per top-level field.
  assert.equal(m.languages.python, 300);
  assert.equal(m.languages.rust, 40, "a language this scan no longer saw is not proof it was unlearned");
  assert.equal(m.models["claude-opus-5"], 200);
  assert.equal(m.hour_buckets[3], 500);
  assert.equal(m.hour_buckets[0], 10);
});

// ---- 2: growth still wins --------------------------------------------------

test("a bigger re-scan still raises the stored month", async () => {
  // Max, not freeze. A snapshot that could only ever be written once would
  // pass test 1 and be useless.
  const home = tmp();
  const { writeSnapshots } = await withHome(home);
  writeSnapshots([bucket()]);
  writeSnapshots([bucket({
    input_tokens: 25_000_000,
    languages: { python: 300, rust: 40, go: 5 },
    hour_buckets: new Array(24).fill(0).map((_, h) => (h === 3 ? 500 : 11)),
  })]);
  const m = readMonth(home, "2026-07");
  assert.equal(m.input_tokens, 25_000_000);
  assert.equal(m.languages.go, 5, "a newly seen language is added");
  assert.equal(m.hour_buckets[0], 11);
  assert.equal(m.sessions, 40, "fields the second scan matched are unchanged");
});

// ---- 3: a held value is announced, never silent ----------------------------

test("keeping the stored value SAYS so — the run cannot silently disagree with the scan", async () => {
  // The merge cannot tell log rotation from a scanner fix that corrects an
  // over-count: ledger.mjs decides that with scanner_version, and a snapshot
  // record carries none. So the stored value wins and the run says which
  // fields it won, rather than the file quietly contradicting the printed scan.
  const home = tmp();
  const { writeSnapshots } = await withHome(home);
  writeSnapshots([bucket()]);
  const warned = await captureWarn(() =>
    writeSnapshots([bucket({ input_tokens: 3_600_000 })])
  );
  assert.match(warned, /2026-07/, "it names the month");
  assert.match(warned, /input_tokens/, "it names the field it kept");
  const quiet = await captureWarn(() => writeSnapshots([bucket()]));
  assert.equal(quiet, "", "an identical re-scan holds nothing back, so it says nothing");
});

// ---- 4: other machines are not touched -------------------------------------

test("the merge is per machine — another machine's entry is left alone", async () => {
  const home = tmp();
  const dir = join(home, ".starreckon", "snapshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-07.json"),
    JSON.stringify({ month: "2026-07", machines: { "other-laptop": bucket({ input_tokens: 5 }) } })
  );
  const { writeSnapshots } = await withHome(home);
  writeSnapshots([bucket({ input_tokens: 7 })]);
  const snap = JSON.parse(readFileSync(join(dir, "2026-07.json"), "utf-8"));
  assert.equal(snap.machines["other-laptop"].input_tokens, 5, "not merged into this host");
  assert.equal(snap.machines[hostname()].input_tokens, 7);
});

// ---- 5: $HOME that is itself a tilde ---------------------------------------

test("a literal '~' in $HOME is expanded, not written into the path", async () => {
  // os.homedir() hands back $HOME verbatim. os.userInfo().homedir reads the
  // passwd entry and ignores $HOME, so it is the one source that cannot come
  // back with a tilde. NOTE: this test only inspects the paths — with HOME='~'
  // they point at the REAL home directory, and writing there from a test would
  // merge fixture numbers into the user's own snapshots.
  const { SNAP_DIR, STAR_DIR } = await withHome("~");
  const real = userInfo().homedir;
  assert.ok(!SNAP_DIR.includes("~"), `SNAP_DIR still carries the tilde: ${SNAP_DIR}`);
  assert.ok(!STAR_DIR.includes("~"), `STAR_DIR still carries the tilde: ${STAR_DIR}`);
  assert.equal(SNAP_DIR, join(real, ".starreckon", "snapshots"));
  assert.equal(STAR_DIR, join(real, ".starreckon", "stars"));
  // The quiet failure is worse than the ENOENT: a relative "~" is writable
  // whenever cwd is, so the snapshots land in a directory named "~" beside the
  // caller and loadTimeline() never looks there again.
  assert.ok(!existsSync(join(process.cwd(), "~")), "a literal '~' directory was created next to cwd");
});

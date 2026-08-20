// @ts-nocheck
// The log the consent screen promises.
//
// The screen shipped saying "a log file will be saved … every run of this layer
// will write one", and for a while nothing wrote one. These tests exist so that
// cannot come back: the first one reads the PROMISE out of consent.mjs and
// requires the writer's real path to match it, so the sentence and the bytes
// are pinned to each other rather than to two people's memory.
//
// The rest are about the one rule the author was explicit on — a ledger at
// every level must be a VIEW of the run records, never a second counter. This
// project has already shipped a second counter that inflated a number 2.71x
// (src/accounts.mjs:443), so "it is a view" is asserted the only way that means
// anything: delete every ledger and require the next run to rebuild them
// identically, and inflate one by hand and require the next run to CORRECT it
// rather than add to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LOG_DIR_SHAPE } from "../src/consent.mjs";
import {
  LEDGER_BASENAME, LOGS_SUBDIR, TRIGGER_ENV,
  collectRuns, dateParts, logLayerRun, logsRoot, scheduledRun, searchDetail, summariseLayerLogs,
  writeNewFile,
} from "../src/layerlog.mjs";
import { buildReceipt, renderReceipt } from "../src/receipt.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const fresh = (tag) => mkdtempSync(join(tmpdir(), `sf-${tag}-`));
const records = (root) =>
  collectRuns(root).records.map((r) => r._file).sort();
const ledgerAt = (...p) => JSON.parse(readFileSync(join(...p), "utf8"));

function runCli(home, args, env = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [CLI, ...args], {
        env: { ...process.env, HOME: home, NO_COLOR: "1", ...env },
        encoding: "utf8",
      }),
    };
  } catch (e) {
    return { status: e.status ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// ---- 1. the promise and the bytes -------------------------------------------

test("the writer's path is exactly the one the consent screen promises", (t) => {
  // LOG_DIR_SHAPE is what the user READ before they answered. Parsing it here,
  // rather than restating it, is what makes this a contract test: change the
  // screen or change the writer and this fails, and it cannot be satisfied by
  // editing the promise to match easier code without the diff saying so.
  const home = fresh("layerlog-shape");
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const when = new Date(2026, 0, 9, 13, 45, 6); // 2026-01-09, local
  const r = logLayerRun({ layer: "daemon", event: "scan", trigger: "schedule" }, { home, now: when });
  assert.equal(r.ok, true, r.error ?? "the record was not written");

  const expected = LOG_DIR_SHAPE.replace(/^~/, home)
    .replace("<year>", "2026")
    .replace("<month>", "01")
    .replace("<day>", "09");
  assert.ok(
    r.record.startsWith(expected),
    `the screen promises ${LOG_DIR_SHAPE} — got ${r.record.replace(home, "~")}`
  );
  // …and the promise says a FILE, not just a directory.
  assert.match(r.record, /\.json$/);
  assert.equal(existsSync(r.record), true);
});

test("the day directory is the LOCAL date, and the record carries the UTC instant too", (t) => {
  // The two are not the same day for most of the planet for part of every day,
  // which is why both are written: the folder is a person's index of their own
  // machine, the instant is what orders two records without a footnote.
  const home = fresh("layerlog-clock");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const when = new Date(2026, 6, 4, 23, 30, 0);
  const r = logLayerRun({ layer: "models", event: "query" }, { home, now: when });
  const rec = JSON.parse(readFileSync(r.record, "utf8"));
  assert.equal(rec.date, "2026-07-04");
  assert.equal(rec.at, when.toISOString());
  assert.equal(rec.tz_offset_minutes, -when.getTimezoneOffset());
  assert.ok(r.record.includes(join("2026", "07", "04")), r.record);
});

// ---- 2. who writes, and who deliberately does not ---------------------------

test("a SCHEDULED daemon run writes a record; the same command typed by hand does not", (t) => {
  // The bargain the consent screen struck: the daemon layer is the schedule. A
  // `protect` a person types and watches is accounted for by the terminal in
  // front of them, and writing a file for it would mean writing files on
  // machines where nobody turned any optional layer on.
  const home = fresh("layerlog-daemon");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, ".starreckon", LOGS_SUBDIR);

  const typed = runCli(home, ["protect"]);
  assert.equal(typed.status, 0, typed.stdout);
  assert.equal(existsSync(root), false, "an interactive run must not create the layer log tree");

  const scheduled = runCli(home, ["protect"], { [TRIGGER_ENV]: "daemon:protect" });
  assert.equal(scheduled.status, 0, scheduled.stdout);
  const got = records(root);
  assert.equal(got.length, 1, `expected one record, got ${got.join(", ")}`);
  const rec = collectRuns(root).records[0];
  assert.equal(rec.layer, "daemon");
  assert.equal(rec.event, "protect");
  assert.equal(rec.trigger, "schedule");
  // "scheduled" is a CLAIM from an env var anyone can export, and the record
  // says whose claim it is instead of presenting it as a measurement.
  assert.equal(rec.trigger_claimed_by, TRIGGER_ENV);
});

test("the schedule files carry the marker that makes a scheduled run identifiable", (t) => {
  if (platform() !== "darwin" && platform() !== "linux") return t.skip("no scheduler wired for this platform");
  const home = fresh("layerlog-schedule");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(runCli(home, ["daemon", "on"]).status, 0);

  const files =
    platform() === "darwin"
      ? [join(home, "Library", "LaunchAgents", "work.starreckon.scan.plist"),
         join(home, "Library", "LaunchAgents", "work.starreckon.protect.plist")]
      : [join(home, ".config", "systemd", "user", "starreckon-scan.service"),
         join(home, ".config", "systemd", "user", "starreckon-protect.service")];
  const want = ["daemon:scan", "daemon:protect"];
  files.forEach((f, i) => {
    const body = readFileSync(f, "utf8");
    assert.ok(body.includes(TRIGGER_ENV), `${f} does not carry ${TRIGGER_ENV} — its runs would write no log`);
    assert.ok(body.includes(want[i]), `${f} does not identify itself as ${want[i]}`);
  });
});

test("a schedule installed before the marker existed is reported, not left silent", (t) => {
  // The upgrade case. An old schedule still scans and still protects, so
  // nothing looks broken — but its runs write no log, and a promise that goes
  // unkept for exactly the runs nobody watches is the worst version of it.
  if (platform() !== "darwin" && platform() !== "linux") return t.skip("no scheduler wired for this platform");
  const home = fresh("layerlog-stale");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(runCli(home, ["daemon", "on"]).status, 0);
  assert.doesNotMatch(runCli(home, ["daemon", "status"]).stdout, /predates the run log/,
    "a freshly written schedule must not be reported as stale");

  const unit =
    platform() === "darwin"
      ? join(home, "Library", "LaunchAgents", "work.starreckon.scan.plist")
      : join(home, ".config", "systemd", "user", "starreckon-scan.service");
  writeFileSync(unit, readFileSync(unit, "utf8").split(TRIGGER_ENV).join("STARRECKON_OLD"));

  const status = runCli(home, ["daemon", "status"]);
  assert.equal(status.status, 0, status.stdout);
  assert.match(status.stdout, /scan job predates the run log/);
  assert.match(status.stdout, /starreckon daemon on/, "it must say the one thing that fixes it");
});

test("every model run writes a record, and the query is not in it", (t) => {
  if (platform() === "win32") return t.skip("uses /bin/true as a stub interpreter");
  const home = fresh("layerlog-models");
  const prev = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  return import("../src/search.mjs").then(async ({ runSearch }) => {
    const secret = "sk-ant-" + "a".repeat(28);
    const code = await runSearch(["query", `find ${secret} in my notes`, "--top", "7"], { python: "/bin/true" });
    assert.equal(code, 0);

    const root = logsRoot(home);
    const found = collectRuns(root).records;
    assert.equal(found.length, 1, "a model invocation must leave exactly one record");
    assert.equal(found[0].layer, "models");
    assert.equal(found[0].event, "query");
    assert.equal(found[0].outcome, "ok");
    assert.equal(found[0].detail.top, 7);
    assert.equal(found[0].detail.query_chars, `find ${secret} in my notes`.length);

    // The whole tree, byte for byte: the user's words are not in it anywhere.
    // receipt.mjs flags stored prose over 400 chars and it walks this tree — a
    // log that kept the query would make this tool's own disclosure command
    // point at this tool.
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(root);
    assert.ok(files.length > 0, "nothing was written at all");
    for (const p of files)
      assert.ok(!readFileSync(p, "utf8").includes(secret), `the query text reached ${p.replace(home, "~")}`);
  });
});

test("a model run that fails is still recorded, with the failure", (t) => {
  if (platform() === "win32") return t.skip("uses /bin/false as a stub interpreter");
  const home = fresh("layerlog-modelfail");
  const prev = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
  return import("../src/search.mjs").then(async ({ runSearch }) => {
    const code = await runSearch(["setup"], { python: "/bin/false" });
    assert.notEqual(code, 0);
    const found = collectRuns(logsRoot(home)).records;
    assert.equal(found.length, 1);
    assert.equal(found[0].event, "setup");
    assert.equal(found[0].outcome, "failed");
    assert.equal(found[0].exit_code, code);
  });
});

// ---- 3. a ledger at every level, and it is a VIEW ---------------------------

test("a ledger is written at every level of the tree", (t) => {
  const home = fresh("layerlog-levels");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const when = new Date(2026, 2, 5, 10, 0, 0);
  const r = logLayerRun({ layer: "daemon", event: "scan", trigger: "schedule" }, { home, now: when });
  const root = logsRoot(home);
  for (const p of [[root], [root, "2026"], [root, "2026", "03"], [root, "2026", "03", "05"]]) {
    const f = join(...p, LEDGER_BASENAME);
    assert.ok(existsSync(f), `no ledger at ${f.replace(home, "~")}`);
  }
  assert.equal(r.ledgers.length, 4);
  assert.equal(ledgerAt(root, LEDGER_BASENAME).level, "root");
  assert.equal(ledgerAt(root, "2026", "03", "05", LEDGER_BASENAME).scope, "2026-03-05");
});

test("every level's ledger is derived from the same records, so they cannot disagree", (t) => {
  const home = fresh("layerlog-agree");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = logsRoot(home);
  // Two days in one month, one of them twice, plus a run in the previous year.
  const runs = [
    [new Date(2025, 11, 31, 9, 0, 0), "daemon", "scan"],
    [new Date(2026, 4, 2, 9, 0, 0), "daemon", "protect"],
    [new Date(2026, 4, 2, 15, 0, 0), "models", "query"],
    [new Date(2026, 4, 9, 15, 0, 0), "models", "setup"],
  ];
  for (const [now, layer, event] of runs) logLayerRun({ layer, event }, { home, now });

  assert.equal(ledgerAt(root, LEDGER_BASENAME).runs, 4);
  assert.equal(ledgerAt(root, "2026", LEDGER_BASENAME).runs, 3);
  assert.equal(ledgerAt(root, "2026", "05", LEDGER_BASENAME).runs, 3);
  assert.equal(ledgerAt(root, "2026", "05", "02", LEDGER_BASENAME).runs, 2);
  assert.equal(ledgerAt(root, "2026", "05", "09", LEDGER_BASENAME).runs, 1);
  // A level's children sum to the level. They are two derivations of one list,
  // not a total and its parts kept in step.
  const year = ledgerAt(root, "2026", LEDGER_BASENAME);
  assert.equal(Object.values(year.children).reduce((a, b) => a + b, 0), year.runs);
  const rootLedger = ledgerAt(root, LEDGER_BASENAME);
  assert.deepEqual(rootLedger.children, { 2025: 1, 2026: 3 });
  assert.deepEqual(rootLedger.by_layer, { daemon: 2, models: 2 });
});

test("DELETE EVERY LEDGER AND THE NEXT RUN REBUILDS THEM IDENTICALLY", (t) => {
  // This is the test that says "view, not counter". A counter cannot pass it:
  // its number lives only in the file, so deleting the file destroys it.
  const home = fresh("layerlog-rebuild");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = logsRoot(home);
  const day = new Date(2026, 7, 18, 8, 0, 0);
  for (let i = 0; i < 3; i++) logLayerRun({ layer: "daemon", event: "scan" }, { home, now: new Date(2026, 7, 18, 8, i) });

  const paths = [
    join(root, LEDGER_BASENAME),
    join(root, "2026", LEDGER_BASENAME),
    join(root, "2026", "08", LEDGER_BASENAME),
    join(root, "2026", "08", "18", LEDGER_BASENAME),
  ];
  // generated_at is a timestamp, not a fact about the records; everything else
  // must come back bit for bit.
  const strip = (o) => { const { generated_at, ...rest } = o; return rest; };
  const before = paths.map((p) => strip(JSON.parse(readFileSync(p, "utf8"))));
  for (const p of paths) rmSync(p);
  for (const p of paths) assert.equal(existsSync(p), false);

  // One more run — which also proves the rebuild is not "restore what I saved".
  logLayerRun({ layer: "daemon", event: "scan" }, { home, now: new Date(2026, 7, 18, 8, 3) });
  const after = paths.map((p) => strip(JSON.parse(readFileSync(p, "utf8"))));

  for (let i = 0; i < paths.length; i++) {
    assert.equal(after[i].runs, before[i].runs + 1, `level ${after[i].level} did not recount from the records`);
    const b = { ...before[i], runs: 0, by_layer: {}, by_event: {}, by_outcome: {}, first_at: 0, last_at: 0, derived_from: 0, children: 0, records: 0 };
    const a = { ...after[i], runs: 0, by_layer: {}, by_event: {}, by_outcome: {}, first_at: 0, last_at: 0, derived_from: 0, children: 0, records: 0 };
    assert.deepEqual(a, b, `level ${after[i].level} came back a different shape`);
  }
  assert.equal(ledgerAt(root, LEDGER_BASENAME).runs, 4);
  assert.equal(day.getDate(), 18);
});

test("an inflated ledger is CORRECTED by the next run, never added to", (t) => {
  // The 2.71x failure, in miniature: a number that a later run adds to is a
  // number that can never come back down. This one is recomputed, so a hand
  // edit survives exactly until the next run and no further.
  const home = fresh("layerlog-inflate");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = logsRoot(home);
  logLayerRun({ layer: "daemon", event: "scan" }, { home, now: new Date(2026, 7, 18, 8, 0) });

  const f = join(root, LEDGER_BASENAME);
  const doc = JSON.parse(readFileSync(f, "utf8"));
  doc.runs = 9999;
  doc.by_layer = { daemon: 9999 };
  writeFileSync(f, JSON.stringify(doc, null, 2));

  logLayerRun({ layer: "daemon", event: "scan" }, { home, now: new Date(2026, 7, 18, 8, 1) });
  const fixed = ledgerAt(root, LEDGER_BASENAME);
  assert.equal(fixed.runs, 2, "the ledger accumulated instead of re-deriving");
  assert.deepEqual(fixed.by_layer, { daemon: 2 });
});

test("a record that cannot be read is counted as unreadable, never as zero", (t) => {
  // The bug this codebase keeps making is that absent looks exactly like zero.
  const home = fresh("layerlog-unreadable");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = logsRoot(home);
  logLayerRun({ layer: "daemon", event: "scan" }, { home, now: new Date(2026, 7, 18, 8, 0) });
  writeFileSync(join(root, "2026", "08", "18", "093000.000-daemon-scan-1-ffff.json"), "{ truncated");

  const s = summariseLayerLogs(root);
  assert.equal(s.runs, 1);
  assert.equal(s.unreadable, 1, "a torn record must be reported, not silently dropped");
  logLayerRun({ layer: "daemon", event: "scan" }, { home, now: new Date(2026, 7, 18, 8, 1) });
  assert.equal(ledgerAt(root, LEDGER_BASENAME).derived_from.unreadable, 1);
});

// ---- 4. two writers at the same moment --------------------------------------

test("a scheduled job and an interactive run writing at the same moment both land", async (t) => {
  // The 6-hour protect tick and a person at a terminal share one home; on the
  // 1st of the month the monthly scan joins them. Records never share a file,
  // and the ledger is written under a lock, so the count is exact rather than
  // "whichever walked last".
  const home = fresh("layerlog-race");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = logsRoot(home);
  const N = 8;
  const src = `
    import { logLayerRun } from ${JSON.stringify(fileURLToPath(new URL("../src/layerlog.mjs", import.meta.url)))};
    const r = logLayerRun({ layer: "daemon", event: "scan", trigger: "schedule" }, { home: ${JSON.stringify(home)} });
    if (!r.ok) { console.error(r.error); process.exit(1); }
  `;
  await Promise.all(
    Array.from({ length: N }, () =>
      new Promise((res, rej) => {
        const c = spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: "inherit" });
        c.on("close", (code) => (code === 0 ? res() : rej(new Error(`writer exited ${code}`))));
      })
    )
  );
  const got = collectRuns(root);
  assert.equal(got.records.length, N, "a concurrent writer lost its record");
  assert.equal(got.unreadable, 0, "a reader saw a half-written file");
  assert.equal(new Set(got.records.map((r) => r._file)).size, N, "two writers picked the same filename");
  // The ledger is the strict half: it is rewritten by every one of them.
  assert.equal(ledgerAt(root, LEDGER_BASENAME).runs, N, "the ledger lost a concurrent update");
});

test("a run record is never overwritten — the writer refuses and says so", (t) => {
  // fleet.mjs:628 writes a machine folder with mkdir -p and writeFileSync and
  // no existence check, so a second submission silently replaces the first
  // machine's totals. A record is the only copy of a fact; replacing one loses
  // it for good. link(2) refuses rather than clobbers, and unlike an
  // existsSync guard there is no window between the check and the write.
  const home = fresh("layerlog-noclobber");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const f = join(home, "record.json");

  assert.equal(writeNewFile(f, "first"), true);
  assert.equal(readFileSync(f, "utf8"), "first");
  assert.equal(writeNewFile(f, "second"), false, "the writer overwrote an existing record");
  assert.equal(readFileSync(f, "utf8"), "first", "the original record was destroyed");
  // and it leaves no temp files behind on either path
  assert.deepEqual(readdirSync(home), ["record.json"]);
});

test("many records from one process in one millisecond all survive", (t) => {
  // Same pid, same timestamp, and only 2 bytes of entropy between them: this is
  // the one case where a name can repeat, and it must cost a redraw, not a
  // record. A writer that overwrote on collision would come back short here.
  const home = fresh("layerlog-burst");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date(2026, 7, 18, 12, 0, 0, 0); // one frozen millisecond
  const N = 300;
  for (let i = 0; i < N; i++) logLayerRun({ layer: "daemon", event: "scan" }, { home, now });
  const got = collectRuns(logsRoot(home));
  assert.equal(got.records.length, N, "a record was lost to a name collision");
  assert.equal(got.unreadable, 0);
  assert.equal(ledgerAt(logsRoot(home), LEDGER_BASENAME).runs, N);
});

// ---- 5. masking -------------------------------------------------------------

test("a record is masked before it is written", (t) => {
  const home = fresh("layerlog-mask");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const r = logLayerRun(
    {
      layer: "models",
      event: "setup",
      detail: { error: `failed reading ${process.env.HOME}/notes with npm_${"b".repeat(36)}` },
    },
    { home }
  );
  const text = readFileSync(r.record, "utf8");
  assert.ok(!text.includes(`npm_${"b".repeat(36)}`), "a credential reached a file on disk");
  assert.match(text, /\[redacted\]/);
  // A detail value is a fact about a run, not a place to park a document.
  const long = logLayerRun({ layer: "models", event: "setup", detail: { note: "x".repeat(5000) } }, { home });
  assert.ok(JSON.parse(readFileSync(long.record, "utf8")).detail.note.length <= 200);
});

test("a mangled Claude project directory name cannot carry the home or the username in", (t) => {
  // Claude Code names a project directory by taking the working-directory path
  // and rewriting every "/" — so ONE string carries the home dir, the username
  // and the project names, and slash-delimited masking never sees it. That is
  // the found leak redact.mjs:77-93 was written for, and starreckon reads that
  // tree on every run, so it is the exact string most likely to arrive here.
  //
  // Two answers, and the test asserts both. (a) No field is POPULATED from a
  // scanned path: a record describes a run — layer, event, outcome, duration —
  // and the only free-text sink is `detail`, which nothing in the scan path
  // feeds. (b) If one arrived anyway, maskText still strips it, because every
  // detail value goes through it at the boundary in detailOf() rather than at
  // the call sites, where a future caller could forget.
  const home = fresh("layerlog-projdir");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const user = process.env.USER || "";
  if (!user || user.length < 4) return t.skip("this machine's username is too short to be maskable");

  const mangled = `-home-${user}-Desktop-ClientWork-billing`;
  const r = logLayerRun(
    { layer: "models", event: "index", detail: { error: `${process.env.HOME}/.claude/projects/${mangled}` } },
    { home }
  );
  const text = readFileSync(r.record, "utf8");
  assert.ok(!text.includes(process.env.HOME), "the home directory reached a log file");
  assert.ok(!text.includes(`-${user}-`), "the username reached a log file inside a mangled project dir name");
  assert.match(text, /\[user\]/, "the username must be replaced, not merely absent by luck");

  // (a), asserted as a property of the whole record rather than of one field:
  // apart from `detail`, every value a record holds is an enum, a number or a
  // timestamp this module generated. None of them can be a path.
  const rec = JSON.parse(text);
  for (const [k, v] of Object.entries(rec)) {
    if (k === "detail") continue;
    assert.ok(typeof v !== "string" || !v.includes("/"), `field ${k} carries a path-shaped value: ${v}`);
  }
});

test("searchDetail keeps the shape of a query and never the query", () => {
  const q = "how did I fix the payment webhook retry bug last quarter";
  const { event, detail } = searchDetail(["query", q, "--top", "3"]);
  assert.equal(event, "query");
  assert.equal(detail.query_chars, q.length);
  assert.equal(detail.top, 3);
  assert.ok(!JSON.stringify(detail).includes("webhook"));
  // Same query, same fingerprint — that is the whole use of keeping one.
  assert.equal(searchDetail(["query", q]).detail.query_sha256_12, detail.query_sha256_12);
  assert.notEqual(searchDetail(["query", q + "!"]).detail.query_sha256_12, detail.query_sha256_12);
  assert.deepEqual(searchDetail(["setup"]), { event: "setup", detail: {} });
});

test("an unrecognised STARRECKON_LAYER_RUN is ignored rather than believed", () => {
  assert.equal(scheduledRun({}), null);
  assert.equal(scheduledRun({ [TRIGGER_ENV]: "" }), null);
  assert.equal(scheduledRun({ [TRIGGER_ENV]: "nonsense:scan" }), null);
  assert.deepEqual(scheduledRun({ [TRIGGER_ENV]: "daemon:scan" }), { layer: "daemon", event: "scan" });
  // A junk event still identifies a daemon run — the layer is the part that
  // decides whether anything is written at all.
  assert.deepEqual(scheduledRun({ [TRIGGER_ENV]: "daemon:../../etc" }), { layer: "daemon", event: "run" });
});

// ---- 6. the receipt tells the truth about the tree ---------------------------

test("the receipt reports the layer log tree, read from the records", (t) => {
  // The fixture is written BY HAND, not by the writer: this asserts that
  // receipt can read the tree, independently of whether the writer produced it.
  const dir = fresh("layerlog-receipt");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const day = join(dir, LOGS_SUBDIR, "2026", "08", "18");
  mkdirSync(day, { recursive: true });
  const rec = (n, layer, outcome) =>
    writeFileSync(
      join(day, `10000${n}.000-${layer}-scan-1-000${n}.json`),
      JSON.stringify({ record: "layer-run", schema: 1, layer, event: "scan", trigger: "schedule",
        at: `2026-08-18T1${n}:00:00.000Z`, date: "2026-08-18", outcome })
    );
  rec(1, "daemon", "ok");
  rec(2, "daemon", "failed");
  rec(3, "models", "ok");

  const r = buildReceipt({ dir });
  assert.ok(r.layer_logs, "the receipt cannot see the layer log tree");
  assert.equal(r.layer_logs.runs, 3);
  assert.equal(r.layer_logs.days, 1);
  assert.deepEqual(r.layer_logs.by_layer, { daemon: 2, models: 1 });
  assert.deepEqual(r.layer_logs.by_outcome, { ok: 2, failed: 1 });

  const out = renderReceipt(r, { color: false });
  assert.match(out, /optional layer runs/);
  assert.match(out, /3 run\(s\) over 1 day\(s\)/);
  assert.match(out, /VIEW recomputed from these records, not a counter/);
  // The heading enumerating the stores must name this one, or it describes a
  // set it no longer covers.
  assert.match(out, /longest free text in STORED DATA \(snapshots, audit, layer logs, reports json\)/);
});

test("the receipt reports a disagreeing ledger instead of repeating it", (t) => {
  // A receipt that echoed a stored number could be made to echo a wrong one.
  const dir = fresh("layerlog-receipt-stale");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, LOGS_SUBDIR);
  const day = join(root, "2026", "08", "18");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "100000.000-daemon-scan-1-0001.json"),
    JSON.stringify({ record: "layer-run", schema: 1, layer: "daemon", event: "scan",
      trigger: "schedule", at: "2026-08-18T10:00:00.000Z", date: "2026-08-18", outcome: "ok" }));
  writeFileSync(join(root, LEDGER_BASENAME),
    JSON.stringify({ record: "layer-ledger", schema: 1, level: "root", scope: "all", runs: 900 }));

  const r = buildReceipt({ dir });
  assert.equal(r.layer_logs.runs, 1, "the receipt took the ledger's word for it");
  assert.equal(r.layer_logs.ledger_runs, 900);
  assert.equal(r.layer_logs.ledger_agrees, false);
  const out = renderReceipt(r, { color: false });
  assert.match(out, /root ledger says 900 and the records say 1/);
  assert.match(out, /RECORDS are/);
});

test("a machine that never turned a layer on has no tree and the receipt says nothing about one", (t) => {
  const dir = fresh("layerlog-receipt-empty");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ extra_roots: [] }));
  const r = buildReceipt({ dir });
  assert.equal(r.layer_logs, null, "an absent tree must be null, not an invented zero");
  assert.doesNotMatch(renderReceipt(r, { color: false }), /optional layer runs/);
});

// ---- 7. the writer cannot break a run ---------------------------------------

test("a log that cannot be written fails quietly and says so, rather than killing the run", (t) => {
  const home = fresh("layerlog-unwritable");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // A FILE where the tree's root has to be a directory: mkdir fails, the writer
  // reports it, and nothing throws.
  mkdirSync(join(home, ".starreckon"), { recursive: true });
  writeFileSync(join(home, ".starreckon", LOGS_SUBDIR), "not a directory");
  const r = logLayerRun({ layer: "daemon", event: "scan" }, { home });
  assert.equal(r.ok, false);
  assert.ok(r.error, "a failure must be reported, not swallowed into a success-shaped result");
  assert.equal(r.record, null);
});

test("dateParts pads to the directory names the tree actually uses", () => {
  const p = dateParts(new Date(2026, 0, 2, 3, 4, 5, 6));
  assert.equal(p.year, "2026");
  assert.equal(p.month, "01");
  assert.equal(p.day, "02");
  assert.equal(p.date, "2026-01-02");
  assert.equal(p.time, "030405.006");
});

test("only logs/YYYY/MM/DD/*.json counts as a run — a stray file is named, not counted", (t) => {
  const home = fresh("layerlog-foreign");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = logsRoot(home);
  logLayerRun({ layer: "daemon", event: "scan" }, { home, now: new Date(2026, 7, 18, 8, 0) });
  writeFileSync(join(root, "2026", "08", "18", "notes.txt"), "hello");
  mkdirSync(join(root, "scratch"), { recursive: true });
  const s = summariseLayerLogs(root);
  assert.equal(s.runs, 1);
  assert.equal(s.foreign, 2, "a stray file must be visible, and must not be a run");
  assert.equal(readdirSync(join(root, "2026", "08", "18")).length, 3);
});

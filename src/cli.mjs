#!/usr/bin/env node
// starforge — privacy-first developer wrapped.
// Scans local AI-coding session logs, redacts + masks BEFORE storing anything,
// keeps rolling monthly snapshots, and renders your skill star live.
//
// The npm package is `starforge-cli` (the bare name `starforge` on npm is an
// unrelated 2017 package — `npx starforge` is NOT this tool). Published: run
// `npx starforge-cli …`, or `node src/cli.mjs …` from a checkout you have read.
//
// Usage:
//   starforge-cli                 scan with interactive exclusion prompts
//   starforge-cli --yes           skip prompts (exclude nothing)
//   starforge-cli --roots=a,b     extra home roots (other accounts/machines)
//   starforge-cli --json          write baseline + expanded JSON reports
//   starforge-cli --card          write the Porter-Grade SVG card
//   starforge-cli --wrapped       (default) the paced story, one card at a time
//   starforge-cli --no-wrapped    skip the story, print the summary only
//   starforge-cli --no-pace       print every wrapped card at once (no [enter])
//   starforge-cli --rates=I,O,C   $/Mtok assumed for the cost estimate
//                                 (input,output,cached). No rate is ever fetched.
//   starforge-cli --page          write the full HTML stats page (implies profile)
//   starforge-cli --profile       compute the judgment/craft profile without
//                                 writing the HTML page
//   starforge-cli --name=NAME     title printed on the card and the stats page
//   starforge-cli --accounts      per-account split + floor (deep walk, slower)
//   starforge-cli --show-accounts write RAW account email addresses into the
//                                 reports/page/fleet folder (default: files get
//                                 stable acct-<hash> pseudonyms instead)
//   starforge-cli --no-projects   write proj-<hash> instead of project names
//                                 into the reports/page/fleet folder (the
//                                 terminal still shows the real names)
//   starforge-cli --no-providers  skip the multi-CLI scan (Gemini/Copilot/…)
//   starforge-cli --fleet=DIR     read a token-usage checkout, show fleet rollup
//   starforge-cli --join-fleet=DIR [--machine=NAME] [--label=LABEL]
//                                 write this machine's folder into the fleet
//                                 (--machine/--label default to this machine's
//                                 hostname)
//   starforge-cli --no-snapshot   don't update ~/.starforge/snapshots (which
//                                 also skips the per-month stars in
//                                 ~/.starforge/stars, since they are drawn from
//                                 the snapshots)
//   starforge-cli --reset-audit[=WHY]
//                                 delete every run log in ~/.starforge/audit and
//                                 start a fresh chain whose first entry RECORDS
//                                 the deletion (count, index range, sha256 of
//                                 each removed log). The only supported way out
//                                 of "a legacy log fails the leak scan, but
//                                 deleting it breaks the chain".
//   starforge-cli verify          adversarial self-check, limits printed
//   starforge-cli prove           print the OS-confinement proof command
//                                 (full scripted proof: sh bin/starforge-proof.sh)
//   starforge-cli daemon on|off|status
//                                 optional scheduled re-scan so snapshots keep
//                                 building past the ~30-day log retention. Writes
//                                 a schedule file and prints the command that
//                                 loads it — it never loads it for you.
//
// Every flag above is registered in FLAG_SPEC below, and every entry in
// FLAG_SPEC appears above (a test asserts both directions). An unregistered
// flag EXITS 2 instead of being ignored — see the comment on FLAG_SPEC.
import { createInterface } from "node:readline/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  discoverSources,
  emptyStats,
  parseClaudeFile,
  parseCodexFile,
  finalize,
  defaultRoots,
} from "./scan.mjs";
import { LiveStar, computeLevels, AXES } from "./star.mjs";
import {
  writeSnapshots,
  writeSnapshotStars,
  loadTimeline,
  velocity,
  SNAP_DIR,
  STAR_DIR,
} from "./snapshots.mjs";
import { maskPath, maskText, maskIdentities, maskProjects } from "./redact.mjs";
import { renderCard } from "./card.mjs";
import { buildCards, renderAll, box, DEFAULT_RATES } from "./wrapped.mjs";
import { writeSchedule, removeSchedule, daemonStatus, describeSchedule } from "./daemon.mjs";
import { scanAllProviders } from "./scanners.mjs";
import { discoverAccounts, floorTotals } from "./accounts.mjs";
import { readFleet, writeMachineFolder } from "./fleet.mjs";
import { collectProfileSignals, computeProfile } from "./profile.mjs";
import { renderStatsPage } from "./statspage.mjs";
import {
  startAudit,
  auditRead,
  auditWrite,
  finishAudit,
  abortAudit,
  armAuditExitHook,
  resetAudit,
  describeRemovedLogs,
  AUDIT_DIR,
} from "./audit.mjs";
import { armTripwire } from "./tripwire.mjs";
import { verifyCli } from "./verify.mjs";
import { detectConfinement, buildProofCommand, sandboxProfile } from "./confine.mjs";

const BOLD = "\x1b[1m", DIM = "\x1b[2m", CYAN = "\x1b[36m", RESET = "\x1b[0m";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};
const fmt = (n) => (n ?? 0).toLocaleString("en-US");
// "…/stars/2026-08.svg" -> "2026-08"
const monthOf = (p) => String(p).split("/").pop().replace(/\.svg$/, "");

// Subcommands are explicit. An unknown positional argument EXITS NON-ZERO
// rather than falling through to a scan — a proof command that silently runs
// something else and prints success would be worse than having none.
const KNOWN_SUBCOMMANDS = new Set(["scan", "verify", "prove", "daemon"]);
const positional = args.filter((a) => !a.startsWith("-"));
const subcommand = positional[0] ?? "scan";
if (!KNOWN_SUBCOMMANDS.has(subcommand)) {
  console.error(
    `starforge-cli: unknown command "${subcommand}". Expected one of: ${[...KNOWN_SUBCOMMANDS].join(", ")}.`
  );
  process.exit(2);
}

// Flags get the SAME treatment as subcommands, and for a stronger reason: the
// privacy flags fail OPEN. `--no-project` (singular typo) used to be ignored in
// silence, so the run wrote every real project name while the user believed
// they had asked for proj-<hash>. Same for `--show-account`, `--no-provider`,
// `--no-snapshots`. A typo that quietly drops a privacy request is worse than a
// refusal, so an unregistered flag exits 2 and nothing is read or written.
//   "bool"  — takes no value            (--json)
//   "value" — REQUIRES one              (--roots=a,b)
//   "opt"   — takes an optional value   (--reset-audit / --reset-audit=WHY)
// This runs BEFORE startAudit() below on purpose: exiting after the audit hook
// is armed would write a run log recording a crash that never happened.
const FLAG_SPEC = Object.freeze({
  "--yes": "bool",
  "--json": "bool",
  "--card": "bool",
  "--wrapped": "bool",
  "--no-wrapped": "bool",
  "--no-pace": "bool",
  "--rates": "value",
  "--page": "bool",
  "--profile": "bool",
  "--accounts": "bool",
  "--show-accounts": "bool",
  "--no-projects": "bool",
  "--no-providers": "bool",
  "--no-snapshot": "bool",
  "--roots": "value",
  "--name": "value",
  "--fleet": "value",
  "--join-fleet": "value",
  "--machine": "value",
  "--label": "value",
  "--reset-audit": "opt",
});
const KNOWN_FLAGS = Object.freeze(Object.keys(FLAG_SPEC));

// Cheap Levenshtein, for "did you mean" only.
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}
function suggestFlag(given) {
  let best = null;
  let bestD = Infinity;
  for (const known of KNOWN_FLAGS) {
    const d = editDistance(given, known);
    if (d < bestD) {
      bestD = d;
      best = known;
    }
  }
  return bestD <= 3 ? best : null;
}
function flagError(message) {
  console.error(`starforge-cli: ${message}`);
  console.error(`known flags: ${KNOWN_FLAGS.join(" ")}`);
  console.error("nothing was read and nothing was written. See the usage header of src/cli.mjs.");
  process.exit(2);
}
for (const a of args) {
  if (!a.startsWith("-")) continue;
  const eq = a.indexOf("=");
  const base = eq === -1 ? a : a.slice(0, eq);
  const kind = FLAG_SPEC[base];
  if (!kind) {
    const hint = suggestFlag(base);
    flagError(
      `unknown flag "${base}".${hint ? ` Did you mean ${hint}?` : ""} Flags are never ignored — a typo in a privacy flag would silently write what you asked to hide.`
    );
  }
  if (kind === "value" && eq === -1)
    flagError(`${base} needs a value: ${base}=<value>.`);
  if (kind === "bool" && eq !== -1)
    flagError(`${base} takes no value (you passed "${a}").`);
  // Every flag above configures the SCAN. `verify` and `prove` read none of
  // them, so accepting one there would be the same silent-ignore this block
  // exists to end — just with a flag that happens to be spelled correctly.
  if (subcommand !== "scan")
    flagError(
      `\`${subcommand}\` takes no flags, and ${base} would have been ignored. Run \`starforge-cli ${subcommand}\` on its own (to re-pin the allowlist manifest: node src/verify.mjs --update-pins).`
    );
}

// `starforge verify` — the adversarial self-check. Runs the static scan, the
// audit chain, the output scrub, and the confinement report, and prints each
// check's limits underneath its result.
// Both entry points go through verifyCli() so the exit-code contract is
// identical: 0 nothing failed · 1 a check FAILED · 2 verify itself crashed.
// (Before, this branch let a crash escape as an uncaught exception and exit 1,
// which made a broken warden indistinguishable from a failing check.)
if (subcommand === "verify") {
  verifyCli();
}

// `starforge daemon on|off|status` — the optional scheduled re-scan.
//
// It writes a schedule file and prints the ONE command that loads it. It does
// not load it. That is not laziness: a tool whose entire claim is "nothing
// leaves your machine" must not silently register a background job that reads
// your disk every month. You get to read the file first, and the step that
// makes it live is a command you typed.
if (subcommand === "daemon") {
  const action = positional[1] ?? "status";
  if (!["on", "off", "status"].includes(action)) {
    console.error(`starforge-cli daemon: expected "on", "off" or "status" (got "${action}")`);
    process.exit(2);
  }
  const st = daemonStatus();
  if (!st.supported) {
    console.log(`starforge-cli daemon: no scheduler wired for ${st.platform}. Run the scan from your own cron/timer:\n  ${process.execPath} ${new URL("./cli.mjs", import.meta.url).pathname} --yes --no-wrapped --no-pace`);
    process.exit(0);
  }

  if (action === "status") {
    console.log(`${BOLD}${CYAN}starforge daemon${RESET} — scheduled local re-scan\n`);
    console.log(`platform:  ${st.platform}`);
    console.log(`schedule:  ${st.installed ? `${maskPath(st.file)} (written)` : "not written"}`);
    if (st.installed) {
      console.log(`\n${DIM}whether it is LOADED is the scheduler's business, not this tool's.${RESET}`);
      console.log(`${DIM}check: ${st.platform === "darwin" ? `launchctl list | grep starforge` : "systemctl --user list-timers starforge-scan.timer"}${RESET}`);
      const body = describeSchedule();
      if (body) console.log(`\n${BOLD}what it will run${RESET}\n${DIM}${body.trim()}${RESET}`);
    }
    process.exit(0);
  }

  if (action === "off") {
    const { removed, deactivate } = removeSchedule();
    if (!removed.length) console.log("no schedule file was written; nothing to remove.");
    else for (const f of removed) console.log(`removed ${maskPath(f)}`);
    console.log(`\n${BOLD}unload it (this tool does not run this for you)${RESET}\n  ${deactivate}`);
    process.exit(0);
  }

  const { files, activate } = writeSchedule();
  console.log(`${BOLD}${CYAN}starforge daemon on${RESET}\n`);
  console.log("Why you might want this: AI-coding logs age off disk after about");
  console.log("30 days. A scan you run once can only ever show one month. The");
  console.log("monthly snapshots outlive the logs — but only if something takes");
  console.log("them regularly. That is all this schedules.\n");
  for (const f of files) console.log(`wrote ${maskPath(f)}`);
  console.log(`\n${BOLD}read it, then load it yourself${RESET}\n  ${activate}`);
  console.log(`\n${DIM}the scheduled run is the same local scan (--yes --no-wrapped --no-pace).${RESET}`);
  console.log(`${DIM}it makes no network calls, and writes under ~/.starforge exactly as${RESET}`);
  console.log(`${DIM}an interactive run does. turn it off with: starforge-cli daemon off${RESET}`);
  process.exit(0);
}

// `starforge prove` — prints the OS-confinement command (the only real proof)
// without running anything, so the user can inspect it and run it themselves.
if (subcommand === "prove") {
  const det = detectConfinement();
  console.log(`${BOLD}${CYAN}starforge prove${RESET} — OS-level no-egress proof\n`);
  console.log(`platform: ${det.platform}   available: ${det.available.join(", ") || "none"}`);
  for (const n of det.notes ?? []) console.log(`  note: ${n}`);
  if (det.recommended === "sandbox-exec") {
    console.log(`\n${BOLD}sandbox profile${RESET}\n${sandboxProfile()}`);
  }
  try {
    console.log(`\n${BOLD}run this yourself${RESET}\n${buildProofCommand({ argv: ["--yes", "--no-snapshot"] })}`);
  } catch (e) {
    console.log(`\nno OS confinement available here: ${maskText(e.message)}`);
  }
  console.log(
    `\nfull scripted proof (scan in-sandbox + positive control):\n  sh ${maskPath(new URL("../bin/starforge-proof.sh", import.meta.url).pathname)}`
  );
  process.exit(0);
}

// Armed before anything is read, and at MODULE scope on purpose: a tripwire
// hit throws, so the log must be reachable from the abort paths below (the
// catch handler and the exit hook) as well as from the end of main(). An alarm
// that erases its own evidence is worse than no alarm. The audit log is
// automatic; the tripwire is a tripwire, not a boundary (TRIPWIRE_LIMITS).
const audit = startAudit(args);
armTripwire(audit.recorder);
armAuditExitHook(audit);

async function main() {
  // Banner honesty: this process cannot prove its own no-egress claim (see
  // README "Privacy model" #2), so it states only what it can back and hands
  // you the command that lets the kernel answer.
  console.log(
    `${BOLD}${CYAN}starforge${RESET} ${DIM}— local-only developer wrapped: reads local logs, writes under ~/.starforge (plus any --join-fleet dir you name).${RESET}\n` +
      `${DIM}  the scan path makes no network calls — but no process can prove that about itself.${RESET}\n` +
      `${DIM}  run \`starforge-cli prove\` (or \`sh bin/starforge-proof.sh\`) and let the kernel answer.${RESET}\n`
  );

  // ---- --reset-audit: the supported way out of a poisoned history ----------
  // A log written by an older version can fail today's leak scan, and deleting
  // it by hand breaks the chain — a bind with no exit. This clears the audit
  // dir and starts a new chain whose GENESIS records the clearing (see
  // resetAudit in audit.mjs). It is a maintenance action: nothing is scanned.
  if (flag("--reset-audit") || opt("reset-audit") !== null) {
    console.log(
      `${BOLD}--reset-audit${RESET} — clearing ${maskPath(AUDIT_DIR)}. The run logs there are DELETED, not moved: copy that directory first if you want to keep them.`
    );
    const res = resetAudit(AUDIT_DIR, { reason: opt("reset-audit") });
    console.log(`removed ${describeRemovedLogs(res.record)}`);
    console.log(
      res.removed_logs > 0
        ? `new chain genesis: ${maskPath(res.path)} — it records each removed log's name and sha256, so a copy you kept can still be matched`
        : `new chain genesis: ${maskPath(res.path)} — it records that a reset happened and that there was nothing to remove`
    );
    console.log(
      `${DIM}the run counter was NOT rolled back: the new chain continues at run_index ${res.run_index}, so how much history existed stays visible. \`starforge-cli verify\` prints this reset under the audit-chain check from now on.${RESET}`
    );
    console.log(`${DIM}nothing was scanned — re-run without --reset-audit to scan.${RESET}`);
    const resetLog = finishAudit(audit);
    if (resetLog)
      console.log(`${DIM}run log:   ${maskPath(resetLog)} — this run, chained onto the genesis above${RESET}`);
    process.exit(0);
  }

  const roots = [...defaultRoots(), ...(opt("roots")?.split(",").filter(Boolean) ?? [])];
  const sources = discoverSources(roots);
  if (sources.length === 0) {
    // Having nothing to scan is NOT an error, and this path exits 0.
    // It used to exit 1, which meant bin/starforge-proof.sh printed
    // "FAIL: … do not trust the no-egress claim" on any clean machine — a
    // fresh container, a CI runner, a laptop without Claude Code — even when
    // the kernel had just refused the escape attempt. The headline proof must
    // never report a network verdict for a reason that has nothing to do with
    // the network.
    //
    // The run log is CLOSED here too (finishAudit -> complete:true, reads {}),
    // because a deliberate early exit is not an abort. Leaving it open marked
    // every first run on a clean machine as "crash, tripwire, or an early
    // exit", and `verify` then reported an INCOMPLETE run. Writing a false
    // abort record is worse than writing nothing.
    console.log("No AI-coding session logs found (looked for Claude Code, Cowork, Codex).");
    console.log(
      `${DIM}nothing to scan is not a failure: exiting 0 with a complete, empty run log (no files were read, none written).${RESET}`
    );
    const emptyLog = finishAudit(audit);
    if (emptyLog)
      console.log(
        `${DIM}run log:   ${maskPath(emptyLog)} — verify it with \`starforge-cli verify\`${RESET}`
      );
    process.exit(0);
  }

  const bySource = {};
  for (const s of sources) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
  console.log(
    "Found: " +
      Object.entries(bySource)
        .map(([k, v]) => `${k} (${v} files)`)
        .join(", ")
  );

  // ---- interactive exclusion ----------------------------------------------
  // The prompt needs a TTY. When there isn't one — `| tee run.log`, CI, a
  // wrapped shell, the sandboxed proof script — it used to be skipped in
  // SILENCE, so a user who never passed --yes was told nothing and reasonably
  // assumed they had been asked. The README sells this prompt as a feature; if
  // it does not happen, the run has to say so.
  let excludedPrefixes = [];
  if (!flag("--yes") && !process.stdin.isTTY) {
    console.log(
      `${DIM}stdin is not a TTY — the exclusion prompt was SKIPPED and NOTHING was excluded; every discovered log was scanned. Run in a terminal to be asked, or pass --yes to say so explicitly.${RESET}`
    );
  }
  if (!flag("--yes") && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (
      await rl.question(
        "\nExclude any sensitive folders/topics from the scan? (comma-separated path fragments, blank = none): "
      )
    ).trim();
    if (ans) excludedPrefixes = ans.split(",").map((s) => s.trim()).filter(Boolean);
    rl.close();
  }
  const excluded = (p) =>
    excludedPrefixes.some((frag) => p.toLowerCase().includes(frag.toLowerCase()));
  if (excludedPrefixes.length)
    console.log(`Excluding paths matching: ${excludedPrefixes.join(", ")}\n`);

  // ---- scan with live star -------------------------------------------------
  const stats = emptyStats();
  const star = new LiveStar();
  let done = 0;
  star.draw(computeLevels(finalize(stats)), `scanning 0/${sources.length}`);
  for (const src of sources) {
    try {
      auditRead(audit, src.source);
      if (src.source === "codex") await parseCodexFile(src.path, stats, { excluded });
      else await parseClaudeFile(src.path, stats, { excluded });
    } catch {}
    done += 1;
    if (done % 5 === 0 || done === sources.length) {
      star.draw(
        computeLevels(finalize(stats)),
        `scanning ${done}/${sources.length}`
      );
    }
  }
  const agg = finalize(stats);
  const levels = computeLevels(agg);
  star.finish(levels, "scan complete");

  // ---- multi-CLI providers (fast, on by default) ---------------------------
  let providers = null;
  if (!flag("--no-providers")) {
    try {
      providers = scanAllProviders(roots);
    } catch {}
  }

  // ---- per-account split + floor (opt-in, deep walk) -----------------------
  // Identity policy (see src/accounts.mjs displayAccount + src/redact.mjs):
  // the account identity is an OAuth EMAIL ADDRESS — the user's real-world
  // name — and reports, the stats page and a --join-fleet folder are all files
  // people sync and share. So every FILE gets the stable pseudonym
  // acct-<8 hex>; the terminal below prints the real addresses next to their
  // pseudonyms, because the terminal is not a file. --show-accounts writes the
  // raw addresses into the files on purpose.
  const showAccounts = flag("--show-accounts");
  // Project policy, same shape as the identity policy above. A project label is
  // the last two segments of a working directory, so a report is a legible list
  // of what you work on — for contract or bounty work, a CLIENT LIST. Labels
  // stay READABLE by default (they are most of the report's value) and every
  // output says so out loud. --no-projects swaps them for the stable pseudonym
  // proj-<8 hex> in every FILE this run writes, while the terminal keeps
  // printing the real names, because the terminal is not a file.
  const noProjects = flag("--no-projects");
  const forFiles = (obj) => (noProjects ? maskProjects(obj) : obj);
  let accounts = null;
  let fleetJoin = null;
  const joinDir = opt("join-fleet");
  if (flag("--accounts") || joinDir) {
    console.log(`\n${DIM}account scan: walking every Claude profile on this machine (can take minutes on big trees)…${RESET}`);
    try {
      const res = await discoverAccounts({ fleet: true, showAccounts });
      accounts = res.rows;
      fleetJoin = res;
    } catch (e) {
      console.log(`account scan failed: ${maskText(e.message)}`);
    }
  }

  // ---- snapshots + velocity ------------------------------------------------
  // Snapshots go through the audit log too — they are written on every default
  // run, so a log that omitted them would report `writes: []` for the most
  // common invocation of the tool.
  if (!flag("--no-snapshot")) writeSnapshots(agg.monthly_buckets, {}, { audit });
  const timeline = loadTimeline();
  const vel = velocity(timeline);
  // Every snapshot gets its own star, drawn only from that month's activity.
  // Laid out in order they show the silhouette changing shape over time, which
  // a single lifetime-average star averages away.
  let starFiles = [];
  if (!flag("--no-snapshot") && timeline.length)
    starFiles = writeSnapshotStars(timeline, { audit });

  // ---- summary -------------------------------------------------------------
  console.log(`\n${BOLD}── profile ─────────────────────────────${RESET}`);
  console.log(`sessions        ${fmt(agg.total_sessions)}  (${agg.active_days} active days, ${agg.total_duration_hours}h active)`);
  console.log(`tokens          ${fmt(agg.total_input_tokens + agg.total_output_tokens)} in+out, ${fmt(agg.total_cache_read_tokens + agg.total_cache_write_tokens)} cache`);
  console.log(`streak          ${agg.longest_streak_days}d longest, ${agg.current_streak_days}d current`);
  const topLangs = Object.entries(agg.languages).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topLangs.length) console.log(`languages       ${topLangs.map(([l, n]) => `${l}(${n})`).join(" ")}`);
  const topProj = agg.projects.slice(0, 5);
  if (topProj.length) {
    console.log(`top projects    ${topProj.map((p) => p.name).join(", ")}`);
    // The screen always shows the real names; say which of the two the FILES
    // will carry, so the user is never guessing what they are about to share.
    console.log(
      noProjects
        ? `${DIM}                --no-projects: files get proj-<hash> instead of these names (e.g. ${topProj[0].name} -> ${maskProjects({ project: topProj[0].name }).project})${RESET}`
        : `${DIM}                these names go into the files as-is; pass --no-projects to write proj-<hash> instead${RESET}`
    );
  }
  const models = Object.entries(agg.models).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (models.length) console.log(`models          ${models.map(([m]) => m).join(", ")}`);

  if (providers) {
    const live = Object.entries(providers.providers).filter(([, p]) => p.sessions > 0);
    if (live.length) {
      console.log(`\n${BOLD}── other CLIs ──────────────────────────${RESET}`);
      for (const [name, p] of live) {
        console.log(
          `${name.padEnd(12)}  ${fmt(p.sessions)} sessions, ${fmt(p.input + p.output)} in+out, ${fmt(p.cacheRead + p.cacheWrite)} cache`
        );
      }
    }
  }

  if (accounts) {
    console.log(`\n${BOLD}── accounts (Claude Code) ──────────────${RESET}`);
    const byAcct = new Map();
    for (const row of accounts) {
      const cur = byAcct.get(row.account) ?? { onDisk: 0, floor: null };
      cur.onDisk +=
        row.onDisk.input + row.onDisk.output + row.onDisk.cacheRead + row.onDisk.cacheWrite;
      if (row.floor)
        cur.floor =
          row.floor.input + row.floor.output + row.floor.cacheRead + row.floor.cacheWrite;
      byAcct.set(row.account, cur);
    }
    // Terminal only: show the real address, and the pseudonym the FILES carry,
    // so the two can be matched up without the address ever being written.
    const identityOf = new Map(
      (fleetJoin?.identities ?? []).map((x) => [x.account, x.identity])
    );
    for (const [acct, t] of [...byAcct.entries()].sort((a, b) => (b[1].floor ?? b[1].onDisk) - (a[1].floor ?? a[1].onDisk))) {
      const who = identityOf.get(acct) ?? acct;
      console.log(
        `${who.padEnd(36)} floor ${fmt(t.floor ?? t.onDisk).padStart(15)}   on disk ${fmt(t.onDisk).padStart(15)}`
      );
      if (who !== acct) console.log(`${DIM}${"".padEnd(36)} in files: ${acct}${RESET}`);
    }
    const fleet = floorTotals(accounts);
    const g = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;
    console.log(`${"MACHINE TOTAL".padEnd(36)} floor ${fmt(g(fleet.floor)).padStart(15)}   on disk ${fmt(g(fleet.onDisk)).padStart(15)}`);
    console.log(
      showAccounts
        ? `${DIM}--show-accounts: the RAW addresses above are written into every file this run produces.${RESET}`
        : `${DIM}addresses stay on this screen — files get the acct-<hash> pseudonym (stable across machines; a salted SHA-256 prefix, so it hides an address from a reader but cannot stop someone confirming a guess). Use --show-accounts to write the real addresses.${RESET}`
    );
  }

  if (vel && vel.months_tracked > 1) {
    console.log(`\n${BOLD}── velocity (${vel.months_tracked} months tracked) ──────${RESET}`);
    const s = (v, unit) => (v === null ? "n/a" : `${v > 0 ? "+" : ""}${v}${unit}`);
    console.log(`hours ${s(vel.hours_mom_pct, "%")} MoM   sessions ${s(vel.sessions_mom_pct, "%")} MoM   tokens ${s(vel.tokens_mom_pct, "%")} MoM   trend ${s(vel.hours_trend_per_month, "h/mo")}`);
  }
  if (starFiles.length) {
    console.log(
      // Range comes from what was actually written, not from the timeline:
      // writeSnapshotStars caps how many months it draws, and printing the full
      // timeline span here would name months that have no star on disk.
      `\nstars: ${starFiles.length} monthly star${starFiles.length === 1 ? "" : "s"} in ${maskPath(STAR_DIR)} — one silhouette per snapshot, ${monthOf(starFiles[0])}..${monthOf(starFiles[starFiles.length - 1])}`
    );
  }

  // ---- fleet read ----------------------------------------------------------
  const fleetDir = opt("fleet");
  let fleetView = null;
  if (fleetDir) {
    try {
      fleetView = readFleet(fleetDir);
      const g = (t) =>
        typeof t === "number" ? t : (t?.input_tokens ?? 0) + (t?.output_tokens ?? 0) + (t?.cache_read_input_tokens ?? 0) + (t?.cache_creation_input_tokens ?? 0);
      console.log(`\n${BOLD}── fleet (${maskPath(fleetDir)}) ──────${RESET}`);
      for (const m of fleetView.machines) {
        const status = m.neverScanned ? "never scanned" : `on disk ${fmt(m.total)}  floor ${fmt(m.floor?.floor ?? m.floor ?? 0)}`;
        console.log(`${(m.label ?? m.folder).padEnd(28)} ${status}`);
      }
      console.log(`${"FLEET".padEnd(28)} on disk ${fmt(g(fleetView.fleetTotals.onDisk))}  floor ${fmt(g(fleetView.fleetTotals.floor))}`);
    } catch (e) {
      console.log(`fleet read failed: ${maskText(e.message)}`);
    }
  }

  // ---- fleet join ----------------------------------------------------------
  if (joinDir && fleetJoin) {
    try {
      // Same identity policy as the Claude accounts: nothing address-shaped
      // reaches the fleet folder unless --show-accounts was passed. Today the
      // other CLIs report literal labels ("gemini (local)"), so this is belt
      // and braces — it costs nothing and it holds if a scanner ever starts
      // reporting a signed-in address.
      const providerSessions = (providers?.perSession ?? []).map((s) => ({
        cli: s.provider,
        session_id: s.session_id,
        account: showAccounts ? s.account : maskIdentities(String(s.account ?? "")),
        project: s.project,
        turns: s.turns,
        duration_min: s.duration_min,
        duration_tight_min: s.duration_tight_min,
        model: s.model,
        billed: s.billed,
        tokens: {
          input_tokens: s.input,
          output_tokens: s.output,
          cache_read_input_tokens: s.cacheRead,
          cache_creation_input_tokens: s.cacheWrite,
        },
      }));
      // The folder name is this machine's identity inside a SHARED directory,
      // so the default has to be this machine. It was hardcoded to
      // "macbook-air-m1" / "MacBook Air M1" — the author's laptop — so every
      // stranger wrote a folder named after someone else's Mac, and two
      // machines that both took the default collided on one folder and
      // overwrote each other. Default to the hostname's short name instead:
      // the hostname already goes into every snapshot (snapshots.mjs), so this
      // discloses nothing the tool was not writing already, and --machine /
      // --label still override it.
      const hostShort = String(hostname() ?? "").split(".")[0].trim();
      const hostSlug =
        hostShort.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) ||
        "unnamed-machine";
      const machineName = opt("machine") ?? hostSlug;
      const machineLabel = opt("label") ?? (hostShort || hostSlug);
      const res = writeMachineFolder(
        joinDir,
        machineName,
        // forFiles: a fleet folder is the most-synced output there is, so
        // --no-projects has to reach it too, not just ~/.starforge.
        forFiles({
          label: machineLabel,
          accounts: fleetJoin.fleetAccounts,
          sessions: [...fleetJoin.fleetSessions, ...providerSessions],
          statsCache: fleetJoin.fleetStatsCache,
          scannerFeatures: ["claude", ...Object.keys(providers?.providers ?? {})],
        })
      );
      console.log(`\nfleet join: wrote ${maskPath(res.dir)} (${res.files.length} files, grand total ${fmt(res.grandTotal)})`);
      // Name only what the reader actually has: the same directory they just
      // passed, read back by this same binary. (This line used to say "run his
      // Python combine.py" — "his" has no referent for anyone but the author,
      // and combine.py is in a repo nobody else can fetch — and it printed the
      // bare name `starforge`, which on npm is an unrelated 2017 package.)
      if (!opt("machine") || !opt("label"))
        console.log(
          `${DIM}folder/label default to this machine's hostname ("${machineName}" / "${machineLabel}") — pass --machine=NAME --label=LABEL to choose your own${RESET}`
        );
      console.log(
        `${DIM}run \`starforge-cli --fleet=${maskPath(joinDir)}\` to see the rollup with this machine included${RESET}`
      );
      console.log(
        showAccounts
          ? `${DIM}this folder contains RAW account email addresses (--show-accounts). If it is synced, they are synced with it.${RESET}`
          : `${DIM}accounts in this folder are acct-<hash> pseudonyms. If you merge it with folders that carry raw addresses, the same account will appear twice — re-run with --show-accounts to line them up.${RESET}`
      );
    } catch (e) {
      console.log(`fleet join failed: ${maskText(e.message)}`);
    }
  }

  // ---- profile + stats page ------------------------------------------------
  let profile = null;
  if (flag("--page") || flag("--profile")) {
    try {
      const signals = await collectProfileSignals(
        sources.map((s) => ({ source: s.source, path: s.path })),
        { excluded }
      );
      profile = computeProfile(signals);
    } catch (e) {
      console.log(`profile failed: ${maskText(e.message)}`);
    }
  }

  // ---- outputs -------------------------------------------------------------
  const outDir = join(homedir(), ".starforge", "reports");
  const stamp = new Date().toISOString().slice(0, 10);
  const name = opt("name");

  if (flag("--json")) {
    mkdirSync(outDir, { recursive: true });
    const baseline = {
      generated_at: new Date().toISOString(),
      total_sessions: agg.total_sessions,
      active_days: agg.active_days,
      total_duration_hours: agg.total_duration_hours,
      total_input_tokens: agg.total_input_tokens,
      total_output_tokens: agg.total_output_tokens,
      monthly_buckets: agg.monthly_buckets,
      longest_streak_days: agg.longest_streak_days,
    };
    const expanded = {
      generated_at: new Date().toISOString(),
      star_levels: Object.fromEntries(AXES.map((a, i) => [a, levels[i]])),
      ...agg,
      providers: providers?.providers ?? null,
      accounts,
      profile,
      velocity: vel,
      timeline,
    };
    const p1 = join(outDir, `baseline-${stamp}.json`);
    const p2 = join(outDir, `expanded-${stamp}.json`);
    writeFileSync(p1, auditWrite(audit, p1, JSON.stringify(forFiles(baseline), null, 2)));
    writeFileSync(p2, auditWrite(audit, p2, JSON.stringify(forFiles(expanded), null, 2)));
    console.log(`\nreports: ${maskPath(p1)}\n         ${maskPath(p2)}`);
    // Say what is in them. "Masked paths only" was never the whole truth: the
    // expanded report names your projects and this machine, by design.
    console.log(
      `${DIM}         these name ${
        noProjects
          ? `your projects as proj-<hash> pseudonyms (--no-projects; ${agg.projects.length} of them)`
          : `your PROJECTS (${agg.projects.length} two-segment labels — pass --no-projects for proj-<hash> instead)`
      } and this machine's hostname (in timeline/snapshots)${accounts ? (showAccounts ? ", plus RAW account email addresses (--show-accounts)" : ", and acct-<hash> pseudonyms, not addresses") : ""}. Read one before you sync or share it.${RESET}`
    );
  }

  let cardSvg = null;
  if (flag("--card") || flag("--page")) {
    cardSvg = renderCard(levels, agg, vel, { name: name ?? "SKILL SCREEN" });
    if (flag("--card")) {
      mkdirSync(outDir, { recursive: true });
      const cardPath = join(outDir, `star-${stamp}.svg`);
      writeFileSync(cardPath, auditWrite(audit, cardPath, cardSvg));
      console.log(`\ncard: ${maskPath(cardPath)} (open in any browser)`);
    }
  }

  if (flag("--page")) {
    mkdirSync(outDir, { recursive: true });
    const html = renderStatsPage(
      // forFiles: the page is the output most likely to be screenshotted or
      // handed to someone, so --no-projects must apply here first of all.
      forFiles({
        profile,
        agg,
        accounts,
        fleet: fleetView,
        providers: providers?.providers ?? null,
        starSvg: cardSvg,
        timeline,
        velocity: vel,
        name,
        showAccounts,
        noProjects,
      })
    );
    const pagePath = join(outDir, `stats-${stamp}.html`);
    writeFileSync(pagePath, auditWrite(audit, pagePath, html));
    // Same honesty rule as the banner: "nothing uploaded" is the one claim this
    // process cannot prove about itself (PROVE-IT.md §1), so state what is
    // checkable — the page was rendered here, from local logs, and contains no
    // remote references — and hand over the check for the rest.
    console.log(
      `page: ${maskPath(pagePath)} (open in any browser — rendered on this machine from your local logs, with no remote references in it; no process can prove its own no-egress claim, see PROVE-IT.md §1)`
    );
  }

  // ---- the wrapped ---------------------------------------------------------
  // Paced like the hosted wrapped everyone recognises, but every number in it
  // came from this process. Where a hosted tool prints "top 17% of users", this
  // prints where you sit in YOUR OWN history — the only comparison a machine
  // that has never seen anyone else's data can honestly make.
  if (!flag("--no-wrapped")) {
    let rates = DEFAULT_RATES;
    const raw = opt("rates");
    if (raw) {
      const parts = raw.split(",").map((n) => Number(n.trim()));
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0))
        flagError(`--rates wants three non-negative numbers: --rates=input,output,cached (got "${raw}")`);
      rates = { in: parts[0], out: parts[1], cache: parts[2], note: "rates you passed with --rates" };
    }
    const cards = buildCards({
      levels,
      agg,
      profile,
      timeline,
      providers: providers?.providers ?? null,
      rates,
      confinement: detectConfinement()?.mode ?? null,
      url: "https://github.com/Alexander-Sorrell-IT/starforge",
    });
    // Pacing needs a TTY and stdin. Piped or --no-pace, print the whole story at
    // once so `| less` and CI both get the full thing instead of hanging on a
    // keypress that will never come.
    const paced = process.stdout.isTTY && process.stdin.isTTY && !flag("--no-pace");
    console.log("");
    if (!paced) {
      console.log(renderAll(cards));
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      for (let i = 0; i < cards.length; i++) {
        console.log(box(cards[i].lines, { color: cards[i].color }));
        const last = i === cards.length - 1;
        console.log(`  ${DIM}[${i + 1}/${cards.length}]${RESET}${last ? "" : `                                        ${DIM}[press ↵]${RESET}`}`);
        if (!last) await rl.question("");
      }
      rl.close();
    }
  }

  // ---- what to do next -----------------------------------------------------
  // Two offers, and the order matters: the proof first, because everything
  // above this line is a claim until you check it.
  console.log(`\n${BOLD}${CYAN}prove it — nothing left this machine${RESET}`);
  console.log(`${DIM}everything you just saw was computed in this process from files already${RESET}`);
  console.log(`${DIM}on your disk. no process can prove that about itself, so don't take it${RESET}`);
  console.log(`${DIM}from this one. run either of these and let the kernel answer:${RESET}`);
  console.log(`  ${CYAN}npx starforge-cli prove${RESET}${DIM}      print the sandbox command, run nothing${RESET}`);
  try {
    const script = maskPath(new URL("../bin/starforge-proof.sh", import.meta.url).pathname);
    console.log(`  ${CYAN}sh ${script}${RESET}`);
    console.log(`${DIM}    runs this scan inside a deny-network sandbox and fires a real TCP${RESET}`);
    console.log(`${DIM}    probe on both sides of the wall: outside it connects, inside the${RESET}`);
    console.log(`${DIM}    kernel refuses with EPERM before a packet can leave.${RESET}`);
  } catch {}
  console.log(`${DIM}  YOU run it — a check this tool ran on itself could be faked by it.${RESET}`);

  const dst = daemonStatus();
  if (dst.supported && !dst.installed) {
    console.log(`\n${BOLD}build a longer history?${RESET}`);
    console.log(`${DIM}AI-coding logs age off disk after ~30 days, so this run can only see${RESET}`);
    console.log(`${DIM}what survives. the monthly snapshots outlive them — if something takes${RESET}`);
    console.log(`${DIM}them regularly. optional, off by default, nothing is installed unless${RESET}`);
    console.log(`${DIM}you run it and then load it yourself:${RESET}`);
    console.log(`  ${CYAN}npx starforge-cli daemon on${RESET}${DIM}   writes a schedule file + prints the${RESET}`);
    console.log(`${DIM}                                 one command that activates it${RESET}`);
  }

  const auditPath = finishAudit(audit);
  console.log(`\n${DIM}snapshots: ${maskPath(SNAP_DIR)} (sync this dir between machines to merge histories)${RESET}`);
  if (auditPath)
    console.log(`${DIM}run log:   ${maskPath(auditPath)} — verify it with \`starforge-cli verify\`${RESET}`);
}

main().catch((e) => {
  // The run died — a tripwire throw, or any other error. Persist the log
  // BEFORE exiting: the one event this log exists to record (a tripwire hit)
  // is precisely the event that aborts the run, and `starforge verify` can
  // only count hits that reached the disk. The log is marked complete:false
  // with a masked abort_reason so an aborted run is not mistaken for a clean
  // one. (The exit hook armed above is the backstop if this path is skipped.)
  const p = abortAudit(audit, `run aborted: ${e?.message ?? e}`);
  // A filesystem permission/space error is an ordinary, fixable condition —
  // usually a ~/.starforge that a `sudo` run left root-owned. Printing a Node
  // stack for it is what a prototype does, and the stack buries the one fact
  // that matters: which path, and what to do. The stack is still available,
  // behind STARFORGE_DEBUG=1 — masked there too, because a crash trace is
  // exactly what gets pasted into a bug report.
  const FS_ERRORS = {
    EACCES: "permission denied",
    EPERM: "operation not permitted",
    ENOSPC: "no space left on the device",
    EROFS: "the filesystem is read-only",
  };
  const why = FS_ERRORS[e?.code];
  if (why) {
    const where = e?.path ? maskPath(String(e.path)) : "a file under ~/.starforge";
    console.error(
      `starforge-cli: ${why} writing ${where} (${e.code}).` +
        (e.code === "EACCES" || e.code === "EPERM"
          ? ` Check who owns it: \`ls -ld ~/.starforge\` — a run under sudo leaves it root-owned. Fix with \`sudo chown -R "$(whoami)" ~/.starforge\`, or move it aside and let this run recreate it.`
          : "") +
        ` Re-run with STARFORGE_DEBUG=1 for the stack trace.`
    );
  }
  // maskText, not console.error(e): a raw stack trace prints absolute module
  // paths (…/Users/<you>/…), and a crash trace is exactly what gets pasted
  // into a bug report. This was the one user-visible output path in the CLI
  // that bypassed masking.
  if (!why || process.env.STARFORGE_DEBUG === "1")
    console.error(maskText(e?.stack ?? String(e)));
  if (p)
    console.error(
      `${DIM}run log:   ${maskPath(p)} (marked incomplete) — inspect it with \`starforge-cli verify\`${RESET}`
    );
  process.exit(1);
});

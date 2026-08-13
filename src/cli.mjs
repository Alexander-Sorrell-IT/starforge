#!/usr/bin/env node
// starreckon — privacy-first developer wrapped.
// Scans local AI-coding session logs, redacts + masks BEFORE storing anything,
// keeps rolling monthly snapshots, and renders your skill star live.
//
// The npm package is `starreckon` (the bare name `starreckon` on npm is an
// unrelated 2017 package — `npx starreckon` is NOT this tool). Published: run
// `npx starreckon …`, or `node src/cli.mjs …` from a checkout you have read.
//
// Usage:
//   starreckon                 scan with interactive exclusion prompts
//   starreckon --yes           skip prompts (exclude nothing)
//   -h / --help                   print this help and exit
//   --full                        full mode: download Cisco SecureBERT models if
//                                 needed, then index sessions after the scan
//   starreckon --star          print ONLY the lifetime star, nothing else
//   starreckon --dual          print ONLY this month beside lifetime
//                                 (--star/--dual suppress the summary, cards,
//                                 QR and menu — the default run shows them all)
//   starreckon --roots=a,b     extra home roots (other accounts/machines)
//   starreckon --json          write baseline + expanded JSON reports
//   starreckon --card          write the Porter-Grade SVG card
//   starreckon --wrapped       (default) the paced story, one card at a time
//   starreckon --no-wrapped    skip the story, print the summary only
//   starreckon --no-pace       print every wrapped card at once (no [enter])
//   starreckon --page          write the full HTML stats page (implies profile)
//   starreckon --profile       compute the judgment/craft profile without
//                                 writing the HTML page
//   starreckon --name=NAME     title printed on the card and the stats page
//   starreckon --accounts      per-account split + floor (deep walk, slower)
//   starreckon --show-accounts write RAW account email addresses into the
//                                 reports/page/fleet folder (default: files get
//                                 stable acct-<hash> pseudonyms instead)
//   starreckon --no-projects   write proj-<hash> instead of project names
//                                 into the reports/page/fleet folder (the
//                                 terminal still shows the real names)
//   starreckon --no-providers  skip the multi-CLI scan (Gemini/Copilot/…)
//   starreckon --fleet=DIR     read a token-usage checkout, show fleet rollup
//   starreckon --join-fleet=DIR [--machine=NAME] [--label=LABEL]
//                                 write this machine's folder into the fleet
//                                 (--machine/--label default to this machine's
//                                 hostname)
//   starreckon --no-snapshot   don't update ~/.starreckon/snapshots (which
//                                 also skips the per-month stars in
//                                 ~/.starreckon/stars, since they are drawn from
//                                 the snapshots)
//   starreckon --contact[=FILE]   set or view contact info shown in the QR
//                                 press [X] in the terminal menu to copy the
//                                 share link (GitHub Pages URL) to clipboard
//                                 (github, email, phone, website, linkedin, twitter)
//                                 omit FILE to use ~/.starreckon/contact.json
//   starreckon serve             start a LAN HTTP server to share your stats page
//                                 on the same WiFi; prints a QR pointing to it
//   starreckon serve --serve-port=N  TCP port (default 3141)
//   starreckon serve --serve-timeout=N  auto-shutdown after N minutes (default 10)
//   starreckon serve --serve-visits=N   auto-shutdown after N visits (default 3)
//   starreckon serve --serve-collect=DIR  accept POST /submit from other machines
//                                 and write each submission as a machine folder in DIR
//   starreckon search QUERY      semantic search over your sessions (SecureBERT)
//   starreckon search --search-setup   download models (~600 MB, one-time)
//   starreckon search --search-index   embed sessions into FAISS index
//   starreckon search --search-status  show index state
//   starreckon search --search-top=N  number of results (default 10)
//   starreckon --beacon        broadcast scan result on LAN, collect peer stars (8s)
//   starreckon --live          stay connected — live peer join/leave + combined star
//   starreckon --reset-audit[=WHY]
//                                 delete every run log in ~/.starreckon/audit and
//                                 start a fresh chain whose first entry RECORDS
//                                 the deletion (count, index range, sha256 of
//                                 each removed log). The only supported way out
//                                 of "a legacy log fails the leak scan, but
//                                 deleting it breaks the chain".
//   starreckon verify          adversarial self-check, limits printed
//   starreckon prove           print the OS-confinement proof command
//                                 (full scripted proof: sh bin/starreckon-proof.sh)
//   starreckon receipt         list every field starreckon has retained about
//                                 you, read from the files themselves (--json
//                                 for the machine-readable pack)
//   starreckon daemon on|off|status
//                                 optional scheduled re-scan so snapshots keep
//                                 building past the ~30-day log retention. Writes
//                                 a schedule file and prints the command that
//                                 loads it — it never loads it for you.
//
// BEFORE-YOU-GO MENU (shown after a scan on an interactive terminal):
//   [P] prove it    [T] transparency  [C] compare   [D] daemon
//   [E] exclusions  [R] reach out     [X] copy link
//   [I] install Cisco models          [Z] re-run scan
//   [H] help        [Q] done
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
import { LiveStar, computeLevels, explainLevels, renderCompare, renderStar, AXES } from "./star.mjs";
import {
  writeSnapshots,
  writeSnapshotStars,
  loadTimeline,
  lifetimeFromTimeline,
  velocity,
  SNAP_DIR,
  STAR_DIR,
} from "./snapshots.mjs";
import { maskPath, maskText, maskIdentities, maskProjects } from "./redact.mjs";
import { renderCard } from "./card.mjs";
import { buildCardsSafe, renderAll, box, shareQrLines } from "./wrapped.mjs";
import { writeSchedule, removeSchedule, daemonStatus, describeSchedule } from "./daemon.mjs";
import { buildReceipt, renderReceipt } from "./receipt.mjs";
import { scanAllProviders } from "./scanners.mjs";
import { discoverAccounts, floorTotals } from "./accounts.mjs";
import { readContact, writeContact, FIELDS as CONTACT_FIELDS, KEYS as CONTACT_KEYS, LABELS as CONTACT_LABELS } from "./contact.mjs";
import { readExclusions, addExclusion, removeExclusion, EXCLUDE_FILE } from "./exclude.mjs";
import { buildShareUrl, PAGES_BASE } from "./shareurl.mjs";
import { readFleet, writeMachineFolder } from "./fleet.mjs";
import { startServe } from "./serve.mjs";
import { fleetAggregates, FLEET_MEASURES, FLEET_MEASURES_MONTH } from "./fleetstar.mjs";
import { ARMS, MAX_LEVEL } from "./starsvg.mjs";
const ARMS_TOTAL = ARMS * MAX_LEVEL;
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
import { detectConfinement, buildProofCommand, sandboxProfile, runConfined, runProbe } from "./confine.mjs";

// NO_COLOR emptied at the source. These four constants are interpolated into
// roughly a hundred template literals in this file — the banner, the summary,
// the fleet rollup, the menu, the pager counter — and gating each one at its
// call site is a hundred chances to miss one. Emptying them here means a
// redirect produces text, whatever gets added later.
const PLAIN = Boolean(process.env.NO_COLOR);
const BOLD = PLAIN ? "" : "\x1b[1m",
  DIM = PLAIN ? "" : "\x1b[2m",
  CYAN = PLAIN ? "" : "\x1b[36m",
  RESET = PLAIN ? "" : "\x1b[0m";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};
const fmt = (n) => (n ?? 0).toLocaleString("en-US");
// --star / --dual: the star is the whole output. Read once, here, because it
// gates three separate things (the scan animation, the scan's own star, and
// everything after the summary) and they must never disagree.
const starOnly = flag("--star") || flag("--dual");
// The title printed above a star. Two stars in one run need to be told apart by
// WHAT THEY WERE COMPUTED FROM — that is the only thing that differs, and the
// numbers alone (27.7 vs 28.9) look like a discrepancy until you know why.
// NO_COLOR is honoured by every other renderer here, and these headings go
// straight into redirected captures — `--dual > stars.txt` must not come out
// full of escape codes.
const starHeading = (what, detail) =>
  console.log(`\n${BOLD}${CYAN}★ ${what}${RESET}${detail ? ` ${DIM}— ${detail}${RESET}` : ""}`);
// "…/stars/2026-08.svg" -> "2026-08"
const monthOf = (p) => String(p).split("/").pop().replace(/\.svg$/, "");

// clipboardCmds lives in ./clipboard.mjs so tests can import it without
// running the CLI. See that file for the full rationale.
import { clipboardCmds } from "./clipboard.mjs";

// Subcommands are explicit. An unknown positional argument EXITS NON-ZERO
// rather than falling through to a scan — a proof command that silently runs
// something else and prints success would be worse than having none.
const KNOWN_SUBCOMMANDS = new Set(["scan", "verify", "prove", "daemon", "receipt", "serve", "search"]);
const positional = args.filter((a) => !a.startsWith("-"));
const subcommand = positional[0] ?? "scan";
if (!KNOWN_SUBCOMMANDS.has(subcommand)) {
  console.error(
    `starreckon: unknown command "${subcommand}". Expected one of: ${[...KNOWN_SUBCOMMANDS].join(", ")}.`
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
  "-h": "bool",
  "--help": "bool",
  "--full": "bool",
  "--star": "bool",
  "--dual": "bool",
  "--json": "bool",
  "--card": "bool",
  "--wrapped": "bool",
  "--no-wrapped": "bool",
  "--no-pace": "bool",
  "--page": "bool",
  "--profile": "bool",
  "--accounts": "bool",
  "--show-accounts": "bool",
  "--no-projects": "bool",
  "--no-providers": "bool",
  "--no-snapshot": "bool",
  "--contact": "opt",
  "--roots": "value",
  "--name": "value",
  "--fleet": "value",
  "--join-fleet": "value",
  "--machine": "value",
  "--label": "value",
  "--reset-audit": "opt",
  "--serve-port": "value",
  "--serve-timeout": "value",
  "--serve-visits": "value",
  "--serve-collect": "value",
  "--search-top": "value",
  "--search-index": "bool",
  "--search-setup": "bool",
  "--search-status": "bool",
  "--beacon": "bool",
  "--live": "bool",
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
  console.error(`starreckon: ${message}`);
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
  // Every flag above configures the SCAN, so accepting one on another
  // subcommand would be the same silent-ignore this block exists to end — just
  // with a flag that happens to be spelled correctly. The one exception is
  // declared, not inferred: `receipt --json` emits the machine-readable pack.
  const SUBCOMMAND_FLAGS = { receipt: new Set(["--json"]), serve: new Set(["--serve-port", "--serve-timeout", "--serve-visits", "--serve-collect"]), search: new Set(["--search-top", "--search-index", "--search-setup", "--search-status", "--roots"]) };
  if (subcommand !== "scan" && !SUBCOMMAND_FLAGS[subcommand]?.has(base))
    flagError(
      `\`${subcommand}\` takes no flags, and ${base} would have been ignored. Run \`starreckon ${subcommand}\` on its own (to re-pin the allowlist manifest: node src/verify.mjs --update-pins).`
    );
}

// printHelp — shared by -h/--help flag and the [H] menu key.
// Both print the same content so there is one source of truth.
function printHelp() {
  const B = BOLD, C = CYAN, D = DIM, R = RESET;
  console.log(`\n${B}${C}starreckon${R}  privacy-first developer wrapped\n`);
  console.log(`${B}BASIC${R}`);
  console.log(`  starreckon              scan + live star + before-you-go menu`);
  console.log(`  starreckon --yes        skip prompts (exclude nothing)`);
  console.log(`  -h / --help                this help`);
  console.log(`  --full                     full mode: download Cisco SecureBERT models`);
  console.log(`                             if needed, then index sessions after scan`);
  console.log(`\n${B}DISPLAY${R}`);
  console.log(`  --star         print ONLY the lifetime star`);
  console.log(`  --dual         print ONLY this month beside lifetime`);
  console.log(`  --card         write the SVG skill card`);
  console.log(`  --page         write the full HTML stats page`);
  console.log(`  --no-wrapped   skip the paced story, print summary only`);
  console.log(`  --no-pace      print all cards at once (no [enter])`);
  console.log(`  --name=NAME    title on the card and stats page`);
  console.log(`\n${B}PRIVACY${R}`);
  console.log(`  --no-projects     write proj-<hash> instead of project names in files`);
  console.log(`  --no-providers    skip the multi-CLI scan (Gemini/Copilot/…)`);
  console.log(`  --show-accounts   write raw email addresses into reports (default: hash)`);
  console.log(`  --no-snapshot     don't update ~/.starreckon/snapshots`);
  console.log(`\n${B}FLEET${R}`);
  console.log(`  --fleet=DIR              read a token-usage checkout, show fleet rollup`);
  console.log(`  --join-fleet=DIR         write this machine's folder into the fleet`);
  console.log(`  --machine=NAME           machine name for --join-fleet`);
  console.log(`  --label=LABEL            display label for --join-fleet`);
  console.log(`\n${B}LAN BEACON${R}`);
  console.log(`  --beacon   after scan: broadcast result on LAN, collect peer stars (8s)`);
  console.log(`  --live     after scan: stay connected — live peer join/leave + combined star`);
  console.log(`             [B] in the menu re-runs the beacon listen on demand`);
  console.log(`  --roots=a,b              extra home roots (other accounts/machines)`);
  console.log(`  --accounts               per-account split + floor (deep walk, slower)`);
  console.log(`\n${B}SUBCOMMANDS${R}`);
  console.log(`  verify          adversarial self-check, limits printed`);
  console.log(`  prove           print the OS-confinement proof command`);
  console.log(`  daemon on|off|status  scheduled re-scan (snapshots outlive ~30-day logs)`);
  console.log(`  receipt         every field starreckon has kept, read from disk`);
  console.log(`  serve           LAN HTTP server to share your stats page`);
  console.log(`  search QUERY    semantic search over sessions (SecureBERT)`);
  console.log(`  search --search-setup   download models (~600 MB, one-time)`);
  console.log(`\n${B}BEFORE-YOU-GO MENU${R} ${D}(shown after a scan on an interactive terminal)${R}`);
  console.log(`  [P] prove it       [T] transparency   [C] compare     [D] daemon`);
  console.log(`  [E] exclusions     [R] reach out      [X] copy link   [B] beacon`);
  console.log(`  [I] install models [Z] re-run scan    [H] this help   [Q] done`);
  console.log(`\n${B}ENVIRONMENT${R}`);
  console.log(`  STARRECKON_DEBUG=1             show full stack on crash`);
  console.log(`  STARRECKON_FORCE_INTERACTIVE=1 force the menu in non-TTY (testing only)`);
  console.log(`  DEADRECKON_MODEL_CACHE=<dir>  shared HuggingFace model cache`);
  console.log(`\n${D}zero dependencies · zero network calls on the scan path · source: github.com/Alexander-Sorrell-IT/starreckon${R}\n`);
}

// -h / --help: print help and exit before anything else runs.
if (flag("-h") || flag("--help")) {
  printHelp();
  process.exit(0);
}

// `starreckon verify` — the adversarial self-check. Runs the static scan, the
// audit chain, the output scrub, and the confinement report, and prints each
// check's limits underneath its result.
// Both entry points go through verifyCli() so the exit-code contract is
// identical: 0 nothing failed · 1 a check FAILED · 2 verify itself crashed.
// (Before, this branch let a crash escape as an uncaught exception and exit 1,
// which made a broken warden indistinguishable from a failing check.)
if (subcommand === "verify") {
  verifyCli();
}

// `starreckon receipt` — the OTHER half of the proof. The kernel proof shows
// nothing was SENT; this shows what was KEPT, by walking ~/.starreckon and
// listing every field in it. A background (daemon) run prints to a log nobody
// watches, so "what you saw in the terminal" cannot account for it — this can.
if (subcommand === "receipt") {
  const r = buildReceipt();
  if (flag("--json")) console.log(JSON.stringify(r, null, 2));
  else console.log(renderReceipt(r, { color: !process.env.NO_COLOR }));
  process.exit(0);
}

// `starreckon daemon on|off|status` — the optional scheduled re-scan.
//
// It writes a schedule file and prints the ONE command that loads it. It does
// not load it. That is not laziness: a tool whose entire claim is "nothing
// leaves your machine" must not silently register a background job that reads
// your disk every month. You get to read the file first, and the step that
// makes it live is a command you typed.
if (subcommand === "daemon") {
  const action = positional[1] ?? "status";
  if (!["on", "off", "status"].includes(action)) {
    console.error(`starreckon daemon: expected "on", "off" or "status" (got "${action}")`);
    process.exit(2);
  }
  const st = daemonStatus();
  if (!st.supported) {
    console.log(`starreckon daemon: no scheduler wired for ${st.platform}. Run the scan from your own cron/timer:\n  ${process.execPath} ${new URL("./cli.mjs", import.meta.url).pathname} --yes --no-wrapped --no-pace`);
    process.exit(0);
  }

  if (action === "status") {
    console.log(`${BOLD}${CYAN}starreckon daemon${RESET} — scheduled local re-scan\n`);
    console.log(`platform:  ${st.platform}`);
    console.log(`schedule:  ${st.installed ? `${maskPath(st.file)} (written)` : "not written"}`);
    if (st.installed) {
      console.log(`\n${DIM}whether it is LOADED is the scheduler's business, not this tool's.${RESET}`);
      console.log(`${DIM}check: ${st.platform === "darwin" ? `launchctl list | grep starreckon` : "systemctl --user list-timers starreckon-scan.timer"}${RESET}`);
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
  console.log(`${BOLD}${CYAN}starreckon daemon on${RESET}\n`);
  console.log("Why you might want this: AI-coding logs age off disk after about");
  console.log("30 days. A scan you run once can only ever show one month. The");
  console.log("monthly snapshots outlive the logs — but only if something takes");
  console.log("them regularly. That is all this schedules.\n");
  for (const f of files) console.log(`wrote ${maskPath(f)}`);
  console.log(`\n${BOLD}read it, then load it yourself${RESET}\n  ${activate}`);
  console.log(`\n${DIM}the scheduled run is the same local scan (--yes --no-wrapped --no-pace).${RESET}`);
  console.log(`${DIM}it makes no network calls, and writes under ~/.starreckon exactly as${RESET}`);
  console.log(`${DIM}an interactive run does. turn it off with: starreckon daemon off${RESET}`);
  process.exit(0);
}

// `starreckon prove` — prints the OS-confinement command (the only real proof)
// without running anything, so the user can inspect it and run it themselves.
if (subcommand === "prove") {
  const det = detectConfinement();
  console.log(`${BOLD}${CYAN}starreckon prove${RESET} — OS-level no-egress proof\n`);
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
    `\nfull scripted proof (scan in-sandbox + positive control):\n  sh ${maskPath(new URL("../bin/starreckon-proof.sh", import.meta.url).pathname)}`
  );
  process.exit(0);
}


// `starreckon serve` — LAN HTTP server. Generates the stats page and serves it
// on the local network so another device on the same WiFi can view it.
// Zero external calls — binds to LAN only. Auto-shuts after a timeout.
if (subcommand === "serve") {
  const port = Number(opt("serve-port") ?? "3141") || 3141;
  const timeout = Number(opt("serve-timeout") ?? "10") || 10;
  const visits = Number(opt("serve-visits") ?? "3") || 3;
  const collectDir = opt("serve-collect") ?? null;
  try {
    await startServe({ port, timeoutMin: timeout, maxVisits: visits, collectDir });
  } catch (e) {
    console.error(`starreckon serve: ${maskText(e.message)}`);
    process.exit(1);
  }
  process.exit(0);
}

// `starreckon search` — semantic search over AI-coding sessions via SecureBERT.
// Delegates entirely to src/search.py running in ~/.starreckon/.venv-search/.
// search.mjs is imported lazily here (not at module top) because it imports
// node:child_process, which the tripwire patches at module load in scan runs.
if (subcommand === "search") {
  const { runSearch, checkPython } = await import("./search.mjs");
  const py = checkPython("python3") ? "python3" : null;
  if (!py) {
    console.error("starreckon search: python3 not found on PATH. Install Python 3.8+ and try again.");
    process.exit(1);
  }
  const roots = opt("roots")?.split(",").filter(Boolean) ?? [];
  let searchArgv;
  if (flag("--search-setup")) {
    searchArgv = ["setup"];
  } else if (flag("--search-index")) {
    searchArgv = ["index"];
  } else if (flag("--search-status")) {
    searchArgv = ["status"];
  } else {
    // positional[1] is the query term
    const query = positional[1];
    if (!query) {
      console.error('starreckon search: provide a query, e.g.  starreckon search "SQL injection"');
      console.error("  or use --search-setup / --search-index / --search-status");
      process.exit(2);
    }
    const top = opt("search-top") ?? "10";
    searchArgv = ["query", query, "--top", top];
  }
  const code = await runSearch(searchArgv, { python: py, roots });
  process.exit(code ?? 0);
}

// Armed before anything is read, and at MODULE scope on purpose: a tripwire
// hit throws, so the log must be reachable from the abort paths below (the
// catch handler and the exit hook) as well as from the end of main(). An alarm
// that erases its own evidence is worse than no alarm. The audit log is
// automatic; the tripwire is a tripwire, not a boundary (TRIPWIRE_LIMITS).
const audit = startAudit(args);
armTripwire(audit.recorder);
armAuditExitHook(audit);

// One star, as data: levels per axis, the total, and — when the source cannot
// measure everything — which axes are a floor and which were not measured at
// all. Used for the `sources` block in the expanded report.
function starOf(agg, available = null) {
  if (!agg) return null;
  const rows = explainLevels(agg, available ? { available } : {});
  return {
    levels: Object.fromEntries(rows.map((r) => [r.axis, r.level])),
    total: +rows.reduce((a, r) => a + r.level, 0).toFixed(1),
    of: ARMS_TOTAL,
    unmeasured: rows.filter((r) => !r.measured).map((r) => r.axis),
    partial: rows.filter((r) => r.partial).map((r) => r.axis),
  };
}

async function main() {
  // Banner honesty: this process cannot prove its own no-egress claim (see
  // README "Privacy model" #2), so it states only what it can back and hands
  // you the command that lets the kernel answer.
  // ...except in the star-only modes, where the star IS the output. The claim
  // is not being dropped: `prove` still exists and the README still carries it.
  if (!starOnly)
    console.log(
      `${BOLD}${CYAN}starreckon${RESET} ${DIM}— local-only developer wrapped: reads local logs, writes under ~/.starreckon (plus any --join-fleet dir you name).${RESET}\n` +
        `${DIM}  the scan path makes no network calls — but no process can prove that about itself.${RESET}\n` +
        `${DIM}  run \`starreckon prove\` (or \`sh bin/starreckon-proof.sh\`) and let the kernel answer.${RESET}\n`
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
      `${DIM}the run counter was NOT rolled back: the new chain continues at run_index ${res.run_index}, so how much history existed stays visible. \`starreckon verify\` prints this reset under the audit-chain check from now on.${RESET}`
    );
    console.log(`${DIM}nothing was scanned — re-run without --reset-audit to scan.${RESET}`);
    const resetLog = finishAudit(audit);
    if (resetLog)
      console.log(`${DIM}run log:   ${maskPath(resetLog)} — this run, chained onto the genesis above${RESET}`);
    process.exit(0);
  }

  // Contact info — read once, used by the QR and the [C] menu.
  const contact = readContact();

  const roots = [...defaultRoots(), ...(opt("roots")?.split(",").filter(Boolean) ?? [])];
  const sources = discoverSources(roots);
  if (sources.length === 0) {
    // Having nothing to scan is NOT an error, and this path exits 0.
    // It used to exit 1, which meant bin/starreckon-proof.sh printed
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
        `${DIM}run log:   ${maskPath(emptyLog)} — verify it with \`starreckon verify\`${RESET}`
      );
    process.exit(0);
  }

  const bySource = {};
  for (const s of sources) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
  if (!starOnly)
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
  const persistedExclusions = readExclusions();
  let excludedPrefixes = [...persistedExclusions];
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
  if (persistedExclusions.length)
    console.log(`${DIM}saved exclusions: ${persistedExclusions.join(", ")}${RESET}`);
  if (excludedPrefixes.length)
    console.log(`Excluding paths matching: ${excludedPrefixes.join(", ")}\n`);

  // ---- scan with live star -------------------------------------------------
  const stats = emptyStats();
  const star = new LiveStar();
  // In star-only mode the animation is "something else" too: its last frame
  // stays on screen above the star we actually want.
  if (starOnly) star.enabled = false;
  let done = 0;
  let lastDraw = 0;
  // A DEFAULT run draws two stars, and two unlabelled near-identical stars are
  // worse than one — you cannot tell which is which, and the footers alone did
  // not say: the first read "scan complete", a progress message, not an
  // identity. Each star gets a heading stating what it was computed FROM.
  if (!starOnly) starHeading("from the logs on disk right now", `${sources.length} files`);
  star.draw(computeLevels(finalize(stats)), `scanning 0/${sources.length}`);
  for (const src of sources) {
    try {
      auditRead(audit, src.source);
      if (src.source === "codex") await parseCodexFile(src.path, stats, { excluded });
      else await parseClaudeFile(src.path, stats, { excluded });
    } catch {}
    done += 1;
    // Throttled by TIME, not by file count. `done % 5` meant a 20,217-file
    // corpus redrew 4,043 times, and each redraw runs finalize() — a full
    // re-aggregation of every session — then repaints 26 lines. The result was
    // slow AND ugly: the terminal could not keep up, so the star juddered
    // instead of growing, and most of the scan was spent recomputing totals
    // nobody saw.
    //
    // ~12 frames a second is smooth to the eye and costs the same whether the
    // corpus is 200 files or 200,000. The last frame is always drawn, so the
    // finished star is never a stale one.
    const now = Date.now();
    if (done === sources.length || now - lastDraw >= 80) {
      lastDraw = now;
      star.draw(
        computeLevels(finalize(stats)),
        `scanning ${done}/${sources.length}`
      );
    }
  }
  const agg = finalize(stats);
  const levels = computeLevels(agg);
  // The star-only modes print their own star, deliberately labelled and drawn
  // from the LIFETIME numbers. Letting finish() land here too would leave the
  // scan's star sitting above it — two stars for --star, three for --dual.
  if (!starOnly) star.finish(levels, "logs on disk now");

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

  // ---- fleet aggregates (needed by star-only modes AND the default run) -----
  // Computed once here, silently. The full fleet summary (per-machine table,
  // floor totals) is printed only in the default run below. Star-only modes
  // just need the levels; they exit before the summary ever prints.
  const fleetDir = opt("fleet");
  let fleetStars = null;
  if (fleetDir) {
    try { fleetStars = fleetAggregates(fleetDir); } catch {}
  }

  // ---- star-only modes -------------------------------------------------------
  //
  // The default run is the whole thing — cards, summary, QR, menu — and there
  // is no reason to hold any of it back. These two flags are the opposite
  // request: give me the star and NOTHING else, so it can be screenshotted,
  // piped, or dropped into a README without trimming twenty lines off it.
  //
  //   --star   the lifetime star, alone
  //   --dual   this month's star and the lifetime star, alone
  //   --fleet  adds fleet star(s) after the corpus ones in either mode
  //
  // They exit before the summary rather than suppressing pieces one by one,
  // because "just the star" is a promise that a later addition somewhere else
  // in this function would quietly break.
  if (flag("--star") || flag("--dual")) {
    const color = !process.env.NO_COLOR;
    const star = (lv, status) => {
      console.log("");
      console.log(renderStar(lv, { color, status }));
    };
    if (flag("--dual")) {
      // Stacked, not side by side: one star is 78 columns wide, so a pair would
      // need 156 and wrap into noise on any normal terminal.
      const month = timeline[timeline.length - 1] ?? null;
      // ONE month is the case to guard, not zero: writeSnapshots() above always
      // seeds the current month, so a first run reaches here with a timeline of
      // length 1 and lifetime IS this month. Drawing both would put two
      // byte-identical stars on screen under different labels — a comparison
      // that reads as "no change since last month" on a first run.
      if (timeline.length <= 1) {
        star(month?.levels ?? levels, "this month · lifetime starts next month");
      } else {
        starHeading("this month", month.month ?? "");
        star(month.levels ?? computeLevels(month), `this month · ${month.month ?? ""}`.trimEnd());
        const life = lifetimeFromTimeline(timeline);
        starHeading("lifetime", `${life.months} months of snapshots`);
        star(life.levels, `lifetime · ${life.months} month(s)`);
      }
      // Fleet star — appended after corpus stars when --fleet=DIR is passed.
      // Labelled clearly: it is a FLOOR (token-usage knows days/projects/models
      // but not languages, tool calls or night hours).
      if (fleetStars?.lifetime) {
        const flife = fleetStars.lifetime;
        const fleetLevels = (agg, avail) => {
          const rows = explainLevels(agg, { available: avail });
          return rows.map((r) => r.level);
        };
        const nFleetMonths = fleetStars.months.length;
        starHeading("fleet lifetime", `${nFleetMonths} months · floor — no languages or tool calls`);
        star(fleetLevels(flife, FLEET_MEASURES), `fleet · ${nFleetMonths} month(s) · floor`);
        if (nFleetMonths) {
          const fm = fleetStars.months[nFleetMonths - 1];
          starHeading("fleet this month", `${fm.month ?? ""} · floor`);
          star(fleetLevels(fm, FLEET_MEASURES_MONTH), `fleet · this month · floor`);
        }
      }
    } else {
      // Prefer the accumulated lifetime over this scan. They are not the same
      // thing: the logs are retained for about a month, so the scan alone is
      // "recently", and calling that "lifetime" would overstate a shrinking
      // window as a total. Snapshots are what outlive the logs.
      const life = timeline.length ? lifetimeFromTimeline(timeline) : null;
      if (life) star(life.levels, `lifetime · ${life.months} month(s)`);
      else star(levels, "this scan · no snapshot history yet");
      // Fleet star — appended when --fleet=DIR is passed.
      if (fleetStars?.lifetime) {
        const flife = fleetStars.lifetime;
        const nFleetMonths = fleetStars.months.length;
        const fleetLevels = (agg, avail) => explainLevels(agg, { available: avail }).map((r) => r.level);
        starHeading("fleet lifetime", `${nFleetMonths} months · floor — no languages or tool calls`);
        star(fleetLevels(flife, FLEET_MEASURES), `fleet · ${nFleetMonths} month(s) · floor`);
      }
    }
    console.log("");
    finishAudit(audit);
    return;
  }

  // ---- the second star, in the DEFAULT run ---------------------------------
  //
  // The star drawn during the scan is "every log still on disk" — about a
  // month, because that is how long the logs are retained. The lifetime star is
  // the one built from snapshots, and it is the number that keeps growing. Only
  // showing the first left the default run looking like a single-star tool and
  // buried the accumulated shape behind the [c] menu, which is a bar table
  // rather than a star.
  //
  // Skipped at one month, where lifetime IS this month and the second star
  // would be a byte-identical copy of the first.
  if (timeline.length > 1) {
    const life = lifetimeFromTimeline(timeline);
    starHeading(
      "lifetime",
      `from ${life.months} saved monthly snapshots — these outlive the logs`
    );
    console.log(
      renderStar(life.levels, {
        color: !process.env.NO_COLOR,
        status: `lifetime · ${life.months} month(s)`,
      })
    );
  }

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

  // ---- fleet read (summary + fleetView for --page / --json) -----------------
  // fleetDir and fleetStars are already computed above for --star/--dual.
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
      // fleetStars already computed above (for --star/--dual). Just print
      // the summary here — the data is the same object.
      if (fleetStars?.lifetime)
        console.log(
          `${DIM}fleet star: ${fleetStars.lifetime.active_days} active days, ` +
            `${fleetStars.lifetime.projects_count} projects, ${fleetStars.months.length} months — ` +
            `a FLOOR (no languages, tool calls or night hours in token-usage)${RESET}`
        );
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
        // --no-projects has to reach it too, not just ~/.starreckon.
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
      // bare name `starreckon`, which on npm is an unrelated 2017 package.)
      if (!opt("machine") || !opt("label"))
        console.log(
          `${DIM}folder/label default to this machine's hostname ("${machineName}" / "${machineLabel}") — pass --machine=NAME --label=LABEL to choose your own${RESET}`
        );
      console.log(
        `${DIM}run \`starreckon --fleet=${maskPath(joinDir)}\` to see the rollup with this machine included${RESET}`
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
  const outDir = join(homedir(), ".starreckon", "reports");
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
      // The 2x2 the CORPUS vs FLEET card shows, machine-readable. Two sources,
      // two spans, four stars, kept apart on purpose: `sources.fleet` is a FLOOR
      // — token-usage records no languages, tool calls or night hours, so those
      // axes are unmeasured there and `measured_inputs` says which. Nothing here
      // is an average of the two.
      sources: {
        corpus: {
          basis: "transcripts still on disk on this machine",
          floor: false,
          month: timeline.length ? starOf(timeline[timeline.length - 1]) : null,
          lifetime: starOf(agg),
        },
        fleet: fleetStars?.lifetime
          ? {
              basis: "token-usage per-machine counters, which outlive deleted transcripts",
              floor: true,
              measured_inputs: FLEET_MEASURES,
              months_tracked: fleetStars.months.length,
              month: fleetStars.months.length
                ? starOf(fleetStars.months[fleetStars.months.length - 1], FLEET_MEASURES_MONTH)
                : null,
              lifetime: starOf(fleetStars.lifetime, FLEET_MEASURES),
            }
          : null,
      },
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
    // floorData: passed to cardFloor — the gap between on-disk tokens and
    // what the stats-cache floor knows. Only populated when --accounts ran.
    const floorData = accounts ? (() => {
      const ft = floorTotals(accounts);
      const g = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;
      return { onDisk: g(ft.onDisk), floor: g(ft.floor) };
    })() : null;
    const cards = buildCardsSafe({
      levels,
      agg,
      // The fleet's OWN aggregate, never merged into agg — the card shows the
      // two side by side and says which is a floor.
      fleetAgg: fleetStars,
      corpusMonth: timeline.length ? timeline[timeline.length - 1] : null,
      profile,
      timeline,
      providers: providers?.providers ?? null,
      confinement: detectConfinement()?.mode ?? null,
      url: "https://github.com/Alexander-Sorrell-IT/starreckon",
      contact,
      floorData,
    });
    // Pacing needs a TTY and stdin. Piped or --no-pace, print the whole story at
    // once so `| less` and CI both get the full thing instead of hanging on a
    // keypress that will never come.
    const paced = process.stdout.isTTY && process.stdin.isTTY && !flag("--no-pace");
    console.log("");
    const qr = shareQrLines(levels, agg, "https://github.com/Alexander-Sorrell-IT/starreckon", contact);
    if (!paced) {
      console.log(renderAll(cards));
      console.log("");
      for (const row of qr) console.log(row);
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      for (let i = 0; i < cards.length; i++) {
        console.log(box(cards[i].lines, { color: cards[i].color }));
        const last = i === cards.length - 1;
        // The QR belongs with the last card, not buried after the menu.
        if (last) { console.log(""); for (const row of qr) console.log(row); }
        console.log(`  ${DIM}[${i + 1}/${cards.length}]${RESET}${last ? "" : `                                        ${DIM}[press ↵]${RESET}`}`);
        if (!last) await rl.question("");
      }
      rl.close();
    }
  }

  // ---- beacon: LAN peer discovery (Mode 1 async, Mode 2 live) ---------------
  // beacon.mjs runs as a CHILD PROCESS — dgram.createSocket is patched to throw
  // in this process. child_process is lazy-imported (same pattern as [Z] re-run).
  // buildBeaconPayload packages the scan result into the compact fleet format.
  const _beaconPath = new URL("./beacon.mjs", import.meta.url).pathname;
  const buildBeaconPayload = () => {
    const machineName = opt("machine") ?? hostname();
    const label = opt("label") ?? machineName;
    // Build a minimal totals object from the current scan's agg
    const totals = {
      accounts: [{ account: "local", ...Object.fromEntries(
        ["input_tokens","cache_creation_input_tokens","cache_read_input_tokens","output_tokens"]
          .map((k) => [k, agg[k] ?? 0])
      )}],
      by_day: [],
      by_model: {},
      by_project: {},
    };
    const months = timeline.slice(-3).map((m) => ({
      month: m.month,
      input_tokens: m.totals?.input_tokens ?? 0,
      output_tokens: m.totals?.output_tokens ?? 0,
      active_days: m.active_days ?? 0,
    }));
    return { machine: machineName, label, totals, months };
  };

  // runBeacon: spawn beacon.mjs, collect peers, render combined fleet star.
  const runBeacon = async (listenMs = 8000) => {
    const { spawnSync: _bss } = await import("node:child_process");
    const payload = buildBeaconPayload();
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    console.log(`\n${DIM}broadcasting on LAN… listening ${listenMs / 1000}s for peers${RESET}`);
    const r = _bss(process.execPath, [
      _beaconPath,
      "--mode=announce",
      `--payload=${b64}`,
      `--listen-ms=${listenMs}`,
    ], { encoding: "utf8", timeout: listenMs + 5000 });
    if (r.status !== 0) {
      console.log(`${DIM}beacon exited ${r.status} — ${r.stderr?.trim() || "no output"}${RESET}`);
      return [];
    }
    let peers = [];
    try { peers = JSON.parse(r.stdout.trim()); } catch { peers = []; }
    // Filter out own machine by hostname
    const own = payload.machine;
    peers = peers.filter((p) => p.machine !== own);
    if (!peers.length) {
      console.log(`${DIM}no other machines found on LAN${RESET}`);
      return [];
    }
    console.log(`\n${BOLD}${CYAN}found ${peers.length} machine(s) on LAN${RESET}`);
    for (const p of peers) {
      const tok = p.totals?.accounts
        ? p.totals.accounts.reduce((s, a) => s + (a.input_tokens ?? 0) + (a.output_tokens ?? 0), 0)
        : 0;
      const tokStr = tok > 1e9 ? `${(tok / 1e9).toFixed(1)}B` : tok > 1e6 ? `${(tok / 1e6).toFixed(1)}M` : `${tok}`;
      console.log(`  ${BOLD}✓${RESET} ${p.label ?? p.machine}  ${DIM}${tokStr} tokens${RESET}`);
    }
    return peers;
  };

  if (flag("--beacon")) {
    await runBeacon(8000);
  }

  if (flag("--live")) {
    // Mode 2: stay connected, stream peer events as NDJSON, render combined
    // fleet star when Ctrl+C is pressed. Only the first machine to run claims
    // coordinator — subsequent machines are peers.
    const payload = buildBeaconPayload();
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    console.log(`\n${BOLD}${CYAN}live mode${RESET} ${DIM}— broadcasting on LAN. Ctrl+C to stop and see combined star.${RESET}`);
    console.log(`${DIM}other machines: npx starreckon --live${RESET}\n`);

    const { spawn: _lspawn } = await import("node:child_process");
    const livePeers = new Map(); // machine -> pkt
    let liveCoord = null;
    let ndjsonBuf = "";

    const beaconChild = _lspawn(process.execPath, [
      _beaconPath, "--mode=live", `--payload=${b64}`, "--coordinator",
    ], { stdio: ["ignore", "pipe", "inherit"] });

    await new Promise((resolve) => {
      beaconChild.stdout.on("data", (chunk) => {
        ndjsonBuf += chunk.toString();
        const lines = ndjsonBuf.split("\n");
        ndjsonBuf = lines.pop() ?? ""; // keep partial last line
        for (const line of lines.filter(Boolean)) {
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.done) {
            // beacon child exited — collect final peer list from done packet
            if (Array.isArray(evt.peers))
              for (const p of evt.peers) livePeers.set(p.machine, p);
            resolve(); return;
          }
          if (evt.type === "join") {
            livePeers.set(evt.peer.machine, evt.peer);
            console.log(`  ${BOLD}${CYAN}+${RESET} ${evt.peer.label ?? evt.peer.machine} joined  ${DIM}(${livePeers.size} total)${RESET}`);
          } else if (evt.type === "leave") {
            livePeers.delete(evt.peer.machine);
            console.log(`  ${DIM}− ${evt.peer.label ?? evt.peer.machine} left  (${livePeers.size} remaining)${RESET}`);
          } else if (evt.type === "coordinator") {
            liveCoord = evt.peer.machine;
            console.log(`  ${DIM}coordinator: ${liveCoord}${RESET}`);
          }
        }
      });
      beaconChild.on("close", resolve);
      process.once("SIGINT", () => beaconChild.kill("SIGINT"));
    });

    // Render combined fleet star from all peers + this machine
    const allPeers = [...livePeers.values()].filter((p) => p.machine !== payload.machine);
    if (allPeers.length) {
      // Build a combined agg from all peer totals + this machine's agg
      const allMachines = [payload, ...allPeers];
      let inTok = 0, outTok = 0, activeDays = 0, months = 0;
      for (const m of allMachines) {
        const accts = m.totals?.accounts ?? [];
        for (const a of accts) {
          inTok += Number(a.input_tokens) || 0;
          outTok += Number(a.output_tokens) || 0;
        }
        activeDays += Number(m.totals?.active_days) || 0;
        months = Math.max(months, (m.months?.length ?? 0));
      }
      const combinedAgg = {
        total_input_tokens: inTok,
        total_output_tokens: outTok,
        total_cache_read_tokens: 0,
        total_cache_write_tokens: 0,
        active_days: activeDays,
        longest_streak_days: 0,
        projects_count: 0,
        models: {},
        months,
      };
      const combinedLevels = computeLevels(combinedAgg);
      starHeading(`live fleet — ${allMachines.length} machines`, `floor · tokens + days only`);
      console.log(renderStar(combinedLevels, {
        color: !process.env.NO_COLOR,
        status: `${allMachines.length} machines · combined floor`,
      }));
    } else {
      console.log(`${DIM}\nno other machines were seen during this session${RESET}`);
    }
  }

  // ---- what to do next -----------------------------------------------------
  // In a terminal these are ACTIONS you press a key for, not commands to copy
  // out and retype. A proof you have to go and assemble yourself is a proof
  // most people never run, and an unrun proof persuades nobody.
  //
  // [p] genuinely executes the thing: the probe outside the sandbox (must
  // connect, or the control is meaningless), the same probe inside it (the
  // kernel must refuse), and the scan itself under the sealed network. The
  // caveat stays printed — a check this process ran on itself is weaker than
  // one you ran — but weaker is not worthless, and the strong form is one
  // keypress away in the same menu.
  // --no-pace is about CARD pacing, not about the menu. Gating both on it meant
  // "print the story at once" also silently removed the proof/receipt/daemon
  // actions, which are the most important thing on the screen. The menu needs a
  // terminal, and nothing else.
  const interactive = (process.stdout.isTTY && process.stdin.isTTY)
    || process.env.STARRECKON_FORCE_INTERACTIVE === "1";
  if (interactive) {
    // When stdin is a pipe (forced-interactive test mode), readline closes as
    // soon as EOF arrives — before sub-menu questions can read their answers.
    // Buffer every line upfront and dequeue them; on a real TTY the readline
    // interface is used directly so the prompt text still appears.
    const realTTY = process.stdout.isTTY && process.stdin.isTTY;
    let lineQueue = null; // null = real TTY, array = piped mode
    let rl = null;
    if (realTTY) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
    } else {
      // Read all piped input into an array of lines before entering the loop.
      lineQueue = await new Promise((resolve) => {
        const lines = [];
        const buf = createInterface({ input: process.stdin });
        buf.on("line", (l) => lines.push(l));
        buf.on("close", () => resolve(lines));
      });
    }
    // ask() prints a prompt and returns the next line (dequeues in pipe mode).
    const ask = async (prompt) => {
      process.stdout.write(prompt);
      if (lineQueue !== null) {
        const line = lineQueue.shift() ?? "";
        process.stdout.write(line + "\n");
        return line;
      }
      return rl.question("");
    };
    let done = false;
    while (!done) {
      console.log(`\n${BOLD}${CYAN}before you go${RESET}`);
      console.log(`  ${BOLD}[P]${RESET} prove it      ${DIM}ask the kernel whether anything can leave${RESET}`);
      console.log(`  ${BOLD}[T]${RESET} transparency  ${DIM}every field this tool KEPT, read from the bytes on disk${RESET}`);
      if (timeline.length)
        console.log(`  ${BOLD}[C]${RESET} compare      ${DIM}local month vs lifetime${fleetStars?.lifetime ? " · or vs fleet" : ""}${RESET}`);
      const dst0 = daemonStatus();
      if (dst0.supported && !dst0.installed)
        console.log(`  ${BOLD}[D]${RESET} daemon       ${DIM}schedule monthly re-scans so history outlives the logs${RESET}`);
      console.log(`  ${BOLD}[E]${RESET} exclusions   ${DIM}add or remove paths never scanned${RESET}`);
      console.log(`  ${BOLD}[R]${RESET} reach out    ${DIM}set contact info shown in the QR (github, email, phone…)${RESET}`);
      console.log(`  ${BOLD}[X]${RESET} copy link    ${DIM}copy share URL to clipboard (paste on any social platform)${RESET}`);
      console.log(`  ${BOLD}[I]${RESET} install models ${DIM}download Cisco SecureBERT for semantic search (one-time ~600 MB)${RESET}`);
      console.log(`  ${BOLD}[B]${RESET} beacon       ${DIM}broadcast on LAN · collect peer stars (8s)${RESET}`);
      console.log(`  ${BOLD}[Z]${RESET} re-run        ${DIM}run a fresh scan now${RESET}`);
      console.log(`  ${BOLD}[H]${RESET} help          ${DIM}all flags and subcommands${RESET}`);
      console.log(`  ${BOLD}[Q]${RESET} done`);
      const key = (await ask("  > ")).trim().toUpperCase();
      if (key === "P") {
        console.log(`\n${BOLD}1/3 probe OUTSIDE the sandbox${RESET} ${DIM}(must connect, or the control is invalid)${RESET}`);
        // In a CHILD process: this one has the tripwire armed, so an in-process
        // probe could never connect and the control would be worthless.
        const outside = await runProbe({ confined: false });
        console.log(`  ${maskText(outside.output ?? "")}`);
        const controlValid = outside.code === 1;
        console.log(`  ${controlValid ? "control VALID — egress really is open here" : "control INVALID — the probe did not connect (offline?)"}`);
        console.log(`\n${BOLD}2/3 the same probe INSIDE the sandbox${RESET} ${DIM}(the kernel must refuse)${RESET}`);
        const inside = await runProbe({ confined: true });
        console.log(`  ${maskText(inside.output ?? "")}`);
        console.log(`  exit ${inside.code} ${DIM}(0 = the kernel refused it)${RESET}`);
        console.log(`\n${BOLD}3/3 the scan itself, network sealed${RESET}`);
        const scan = await runConfined({ argv: ["--yes", "--no-snapshot", "--no-wrapped", "--no-providers"], quiet: true });
        console.log(`  exit ${scan.code} ${DIM}(0 = it completed with no network at all)${RESET}`);
        const pass = controlValid && inside.code === 0 && scan.code === 0;
        console.log(`\n${pass ? `${BOLD}PASS${RESET} — egress open outside, refused inside, scan fine either way` : `${BOLD}INCONCLUSIVE${RESET} — read the three results above`}`);
        console.log(`${DIM}this ran from inside starreckon, so it is the weaker form. the strong${RESET}`);
        console.log(`${DIM}one is you running it: sh bin/starreckon-proof.sh${RESET}`);
      } else if (key === "T") {
        console.log("");
        console.log(renderReceipt(buildReceipt(), { color: !process.env.NO_COLOR }));
      } else if (key === "C" && timeline.length) {
        // Compare sub-menu: local, fleet, or both
        const thisMonth = timeline[timeline.length - 1];
        const life = lifetimeFromTimeline(timeline);
        const hasFleet = Boolean(fleetStars?.lifetime);
        console.log(`\n${BOLD}compare${RESET}`);
        console.log(`  ${BOLD}[L]${RESET}  local   ${DIM}this month vs your corpus lifetime${RESET}`);
        if (hasFleet) {
          console.log(`  ${BOLD}[F]${RESET}  fleet   ${DIM}this month vs fleet lifetime${RESET}`);
          console.log(`  ${BOLD}[B]${RESET}  both    ${DIM}corpus month · corpus lifetime · fleet lifetime${RESET}`);
        }
        console.log(`  ${BOLD}[←]${RESET}  back`);
        const ck = (await ask("  > ")).trim().toUpperCase();
        const color = !process.env.NO_COLOR;
        let compareBody = null;
        if (ck === "L" || (!hasFleet && ck !== "")) {
          console.log("");
          compareBody = renderCompare(thisMonth, life, { color });
          console.log(compareBody);
        } else if (ck === "F" && hasFleet) {
          // Fleet month (last) vs fleet lifetime
          const fleetMonth = fleetStars.months.length
            ? fleetStars.months[fleetStars.months.length - 1] : null;
          if (fleetMonth) {
            console.log("");
            compareBody = renderCompare(fleetMonth, fleetStars.lifetime, { color});
            console.log(compareBody);
          } else {
            console.log(`  ${DIM}fleet has only one month of data — nothing to compare yet${RESET}`);
          }
        } else if (ck === "B" && hasFleet) {
          console.log("");
          const localCmp = renderCompare(thisMonth, life, { color});
          const fleetMonth = fleetStars.months.length
            ? fleetStars.months[fleetStars.months.length - 1] : null;
          console.log(localCmp);
          if (fleetMonth) {
            console.log("");
            const fleetCmp = renderCompare(fleetMonth, fleetStars.lifetime, { color});
            console.log(fleetCmp);
            compareBody = localCmp + "\n\n" + fleetCmp;
          } else {
            compareBody = localCmp;
          }
        }
        // Save offer
        if (compareBody !== null) {
          const save = (await ask(`\n  save to a file? ${DIM}[y/N]${RESET} `)).trim().toUpperCase();
          if (save === "Y") {
            mkdirSync(outDir, { recursive: true });
            const p = join(outDir, `compare-${stamp}.txt`);
            const bodyPlain = compareBody.replace(/\x1b\[[0-9;]*m/g, "");
            writeFileSync(p, auditWrite(audit, p,
              bodyPlain + `\n\ngenerated ${new Date().toISOString()} by starreckon\n`));
            console.log(`  wrote ${maskPath(p)}`);
          } else {
            console.log(`  ${DIM}not saved.${RESET}`);
          }
        }
      } else if (key === "E") {
        // [E] exclusions — add or remove persisted scan exclusions
        const curExcl = readExclusions();
        const exclFile = EXCLUDE_FILE.replace(homedir(), "~");
        console.log(`\n${BOLD}saved exclusions${RESET} ${DIM}(${exclFile})${RESET}`);
        if (!curExcl.length) {
          console.log(`  ${DIM}none — every session is scanned${RESET}`);
        } else {
          curExcl.forEach((e, i) => console.log(`  ${BOLD}[${i}]${RESET}  ${e}`));
        }
        console.log(`\n  type a fragment to ADD    e.g.  client-work  or  /private/`);
        console.log(`  type a number to REMOVE   e.g.  0`);
        console.log(`  blank = back`);
        const eAns = (await ask("  > ")).trim();
        if (eAns === "") { /* back */ }
        else if (/^\d+$/.test(eAns)) {
          const idx = parseInt(eAns, 10);
          if (idx >= 0 && idx < curExcl.length) {
            const next = removeExclusion(idx);
            console.log(`  removed "${curExcl[idx]}"`);
            console.log(next.length ? `  remaining: ${next.join(", ")}` : `  ${DIM}no exclusions saved${RESET}`);
          } else {
            console.log(`  ${DIM}no entry at [${idx}]${RESET}`);
          }
        } else {
          const next = addExclusion(eAns);
          console.log(`  saved. active next scan: ${next.join(", ")}`);
        }
      } else if (key === "R") {
        // [R] reach out — edit contact info written into the QR
        let ct = readContact();
        let rDone = false;
        while (!rDone) {
          console.log(`
${BOLD}${CYAN}── reach out (shown in QR) ──────────────────${RESET}`);
          const fieldKeys = ["G","E","P","W","L","T"];
          const fieldMap  = { G:"github", E:"email", P:"phone", W:"website", L:"linkedin", T:"twitter" };
          const labelMap  = { G:"GitHub", E:"Email", P:"Phone", W:"Website", L:"LinkedIn", T:"Twitter/X" };
          for (const k of fieldKeys) {
            const f = fieldMap[k];
            const val = ct[f] ? `${BOLD}${ct[f]}${RESET}` : `${DIM}(not set)${RESET}`;
            console.log(`  ${BOLD}[${k}]${RESET}  ${labelMap[k].padEnd(10)} ${val}`);
          }
          console.log(`  ${BOLD}[X]${RESET}  Clear ALL`);
          console.log(`  ${BOLD}[←]${RESET}  Back (done)`);
          const rk = (await ask("  > ")).trim().toUpperCase();
          if (rk === "" || rk === "B" || rk === "BACK") {
            rDone = true;
          } else if (rk === "X") {
            writeContact(undefined, {});
            ct = {};
            console.log(`  ${DIM}all contact info cleared.${RESET}`);
          } else if (fieldMap[rk]) {
            const field = fieldMap[rk];
            const label = labelMap[rk];
            const cur = ct[field];
            console.log(`
  ${BOLD}── ${label} ──────────────────────────────${RESET}`);
            if (cur) console.log(`  current: ${BOLD}${cur}${RESET}`);
            else console.log(`  ${DIM}(not set)${RESET}`);
            console.log(`  ${BOLD}[E]${RESET} edit   ${BOLD}[X]${RESET} clear   ${BOLD}[←]${RESET} back`);
            const fk = (await ask("  > ")).trim().toUpperCase();
            if (fk === "E") {
              const val = (await ask(`  new value for ${label}: `)).trim();
              if (val) {
                ct[field] = val;
                writeContact(undefined, ct);
                console.log(`  saved.`);
              } else {
                console.log(`  ${DIM}empty — not saved.${RESET}`);
              }
            } else if (fk === "X") {
              delete ct[field];
              writeContact(undefined, ct);
              console.log(`  ${label} cleared.`);
            }
          }
        }
        // Refresh contact so the QR on any subsequent re-render is current
        Object.assign(contact, readContact());
      } else if (key === "D") {
        const { files, activate } = writeSchedule();
        console.log("");
        for (const f of files) console.log(`wrote ${maskPath(f)}`);
        console.log(`${BOLD}read it, then load it yourself:${RESET}\n  ${activate}`);
        console.log(`${DIM}this tool does not load it for you.${RESET}`);
      } else if (key === "X") {
        // [X] copy share link — build the GitHub Pages URL and copy to clipboard
        const shareUrl = buildShareUrl(levels, agg, opt("name"));
        if (!shareUrl) {
          console.log(`  ${DIM}could not build share URL — run with --name=NAME to include a label${RESET}`);
        } else {
          console.log(`\n  ${BOLD}${CYAN}${shareUrl}${RESET}`);
          // Copy to clipboard using the right tool for this OS/desktop session.
          // clipboardCmds() picks the correct command — see its comment for why
          // xdotool is excluded (it types into the focused window, not the clipboard).
          const { spawnSync: _spawnSync } = await import("node:child_process");
          const caption = `my starreckon skill star — computed locally, zero upload\n${shareUrl}`;
          const cmds = clipboardCmds();
          let copied = false;
          for (const [cmd, cmdArgs] of cmds) {
            const r = _spawnSync(cmd, cmdArgs, { input: caption, encoding: "utf8", timeout: 3000 });
            if (r.status === 0 && !r.error) { copied = true; break; }
          }
          if (copied) {
            console.log(`  ${DIM}copied to clipboard — paste on Twitter, LinkedIn, Bluesky, anywhere${RESET}`);
          } else {
            const names = cmds.map(([c]) => c).join(", ");
            console.log(`  ${DIM}clipboard copy failed (tried: ${names}) — copy the URL above manually${RESET}`);
          }
          console.log(`  ${DIM}the page renders your star from the URL fragment — no server needed${RESET}`);
          }
        } else if (key === "I") {
          // [I] install Cisco SecureBERT models for semantic search
          const { checkPython, runSearch } = await import("./search.mjs");
          const py = checkPython("python3") ? "python3" : null;
          if (!py) {
            console.log(`  ${DIM}python3 not found on PATH — install Python 3.8+ then press [I] again${RESET}`);
          } else {
            const { existsSync } = await import("node:fs");
            const { homedir: _hd } = await import("node:os");
            const venv = _hd() + "/.starreckon/.venv-search";
            if (existsSync(venv + "/bin/python") || existsSync(venv + "/Scripts/python.exe")) {
              console.log(`  ${DIM}models already installed at ~/.starreckon/.venv-search${RESET}`);
              console.log(`  ${DIM}run: starreckon search "your query"${RESET}`);
            } else {
              console.log(`\n  downloading Cisco SecureBERT models (~600 MB) — this takes a few minutes…\n`);
              const code = await runSearch(["setup"], { python: py });
              if (code === 0) {
                console.log(`\n  ${DIM}models installed. run: starreckon search "your query"${RESET}`);
              } else {
                console.log(`\n  ${DIM}setup exited ${code} — re-run: starreckon search --search-setup${RESET}`);
              }
            }
          }
        } else if (key === "B") {
          // [B] beacon — broadcast this machine's result and collect peers
          await runBeacon(8000);
        } else if (key === "Z") {
          // [Z] re-run — spawn a fresh scan with the same original argv (minus
          // any menu-only flags), streaming output directly to the terminal.
          if (rl) rl.close();
          const { spawnSync: _ss } = await import("node:child_process");
          const rerunArgv = args.filter((a) => a !== "-h" && a !== "--help");
          _ss(process.execPath, [new URL(import.meta.url).pathname, ...rerunArgv], {
            stdio: "inherit",
            env: { ...process.env },
          });
          return; // parent process exits after child finishes
        } else if (key === "H") {
          // [H] help — print grouped help, stay in menu
          printHelp();
        } else {
          done = true;
        }
      }
    if (rl) rl.close();
  }

  // Two offers, and the order matters: the proof first, because everything
  // above this line is a claim until you check it.
  if (!interactive) {
  console.log(`\n${BOLD}${CYAN}prove it — nothing left this machine${RESET}`);
  console.log(`${DIM}everything you just saw was computed in this process from files already${RESET}`);
  console.log(`${DIM}on your disk. no process can prove that about itself, so don't take it${RESET}`);
  console.log(`${DIM}from this one. run either of these and let the kernel answer:${RESET}`);
  console.log(`  ${CYAN}npx starreckon prove${RESET}${DIM}      print the sandbox command, run nothing${RESET}`);
  try {
    const script = maskPath(new URL("../bin/starreckon-proof.sh", import.meta.url).pathname);
    console.log(`  ${CYAN}sh ${script}${RESET}`);
    console.log(`${DIM}    runs this scan inside a deny-network sandbox and fires a real TCP${RESET}`);
    console.log(`${DIM}    probe on both sides of the wall: outside it connects, inside the${RESET}`);
    console.log(`${DIM}    kernel refuses with EPERM before a packet can leave.${RESET}`);
  } catch {}
  console.log(`${DIM}  YOU run it — a check this tool ran on itself could be faked by it.${RESET}`);
  // Egress is only half the question. A tool that never opens a socket can
  // still keep more than it showed you — and a scheduled run shows you nothing
  // at all, so the terminal cannot be the accounting.
  console.log(`  ${CYAN}npx starreckon receipt${RESET}${DIM}    the other half: every field it has${RESET}`);
  console.log(`${DIM}    KEPT about you, listed from the bytes in ~/.starreckon — not from${RESET}`);
  console.log(`${DIM}    what the code claims. covers scheduled runs too, which is the${RESET}`);
  console.log(`${DIM}    only accounting a background scan can have.${RESET}`);

  }

  const dst = daemonStatus();
  if (!interactive && dst.supported && !dst.installed) {
    console.log(`\n${BOLD}build a longer history?${RESET}`);
    console.log(`${DIM}AI-coding logs age off disk after ~30 days, so this run can only see${RESET}`);
    console.log(`${DIM}what survives. the monthly snapshots outlive them — if something takes${RESET}`);
    console.log(`${DIM}them regularly. optional, off by default, nothing is installed unless${RESET}`);
    console.log(`${DIM}you run it and then load it yourself:${RESET}`);
    console.log(`  ${CYAN}npx starreckon daemon on${RESET}${DIM}   writes a schedule file + prints the${RESET}`);
    console.log(`${DIM}                                 one command that activates it${RESET}`);
  }

  // --full: after the scan, auto-index sessions so search works immediately.
  // search.mjs is imported lazily here (not at module top) because it imports
  // node:child_process, which the tripwire patches at module load in scan runs.
  if (flag("--full")) {
    const { checkPython, runSearch } = await import("./search.mjs");
    const py = checkPython("python3") ? "python3" : null;
    if (!py) {
      console.log(`\n${DIM}--full: python3 not found — skipping model setup. Install Python 3.8+ to use Cisco SecureBERT search.${RESET}`);
    } else {
      const { existsSync: _exists } = await import("node:fs");
      const { homedir: _hd2 } = await import("node:os");
      const venv = _hd2() + "/.starreckon/.venv-search";
      const venvReady = _exists(venv + "/bin/python") || _exists(venv + "/Scripts/python.exe");
      if (!venvReady) {
        console.log(`\n${DIM}--full: downloading Cisco SecureBERT models (~600 MB)…${RESET}`);
        const setupCode = await runSearch(["setup"], { python: py });
        if (setupCode !== 0) {
          console.log(`${DIM}--full: model setup failed (exit ${setupCode}) — skipping index${RESET}`);
        } else {
          console.log(`${DIM}--full: indexing sessions…${RESET}`);
          await runSearch(["index"], { python: py });
        }
      } else {
        console.log(`\n${DIM}--full: indexing sessions with SecureBERT…${RESET}`);
        await runSearch(["index"], { python: py });
      }
    }
  }

  const auditPath = finishAudit(audit);
  console.log(`\n${DIM}snapshots: ${maskPath(SNAP_DIR)} (sync this dir between machines to merge histories)${RESET}`);
  if (auditPath)
    console.log(`${DIM}run log:   ${maskPath(auditPath)} — verify it with \`starreckon verify\`${RESET}`);
}

main().catch((e) => {
  // The run died — a tripwire throw, or any other error. Persist the log
  // BEFORE exiting: the one event this log exists to record (a tripwire hit)
  // is precisely the event that aborts the run, and `starreckon verify` can
  // only count hits that reached the disk. The log is marked complete:false
  // with a masked abort_reason so an aborted run is not mistaken for a clean
  // one. (The exit hook armed above is the backstop if this path is skipped.)
  const p = abortAudit(audit, `run aborted: ${e?.message ?? e}`);
  // A filesystem permission/space error is an ordinary, fixable condition —
  // usually a ~/.starreckon that a `sudo` run left root-owned. Printing a Node
  // stack for it is what a prototype does, and the stack buries the one fact
  // that matters: which path, and what to do. The stack is still available,
  // behind STARRECKON_DEBUG=1 — masked there too, because a crash trace is
  // exactly what gets pasted into a bug report.
  const FS_ERRORS = {
    EACCES: "permission denied",
    EPERM: "operation not permitted",
    ENOSPC: "no space left on the device",
    EROFS: "the filesystem is read-only",
  };
  const why = FS_ERRORS[e?.code];
  if (why) {
    const where = e?.path ? maskPath(String(e.path)) : "a file under ~/.starreckon";
    console.error(
      `starreckon: ${why} writing ${where} (${e.code}).` +
        (e.code === "EACCES" || e.code === "EPERM"
          ? ` Check who owns it: \`ls -ld ~/.starreckon\` — a run under sudo leaves it root-owned. Fix with \`sudo chown -R "$(whoami)" ~/.starreckon\`, or move it aside and let this run recreate it.`
          : "") +
        ` Re-run with STARRECKON_DEBUG=1 for the stack trace.`
    );
  }
  // maskText, not console.error(e): a raw stack trace prints absolute module
  // paths (…/Users/<you>/…), and a crash trace is exactly what gets pasted
  // into a bug report. This was the one user-visible output path in the CLI
  // that bypassed masking.
  if (!why || process.env.STARRECKON_DEBUG === "1")
    console.error(maskText(e?.stack ?? String(e)));
  if (p)
    console.error(
      `${DIM}run log:   ${maskPath(p)} (marked incomplete) — inspect it with \`starreckon verify\`${RESET}`
    );
  process.exit(1);
});

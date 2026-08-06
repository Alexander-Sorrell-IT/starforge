#!/usr/bin/env node
// starforge — privacy-first developer wrapped.
// Scans local AI-coding session logs, redacts + masks BEFORE storing anything,
// keeps rolling monthly snapshots, and renders your skill star live.
//
// Usage:
//   npx starforge                 scan with interactive exclusion prompts
//   npx starforge --yes           skip prompts (exclude nothing)
//   npx starforge --roots=a,b     extra home roots (other accounts/machines)
//   npx starforge --json          write baseline + expanded JSON reports
//   npx starforge --card          write the Porter-Grade SVG card
//   npx starforge --page          write the full HTML stats page (implies profile)
//   npx starforge --accounts      per-account split + floor (deep walk, slower)
//   npx starforge --no-providers  skip the multi-CLI scan (Gemini/Copilot/…)
//   npx starforge --fleet=DIR     read a token-usage checkout, show fleet rollup
//   npx starforge --join-fleet=DIR [--machine=NAME] [--label=LABEL]
//                                 write this machine's folder into the fleet
//   npx starforge --no-snapshot   don't update ~/.starforge/snapshots
import { createInterface } from "node:readline/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
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
import { writeSnapshots, loadTimeline, velocity, SNAP_DIR } from "./snapshots.mjs";
import { maskPath } from "./redact.mjs";
import { renderCard } from "./card.mjs";
import { scanAllProviders } from "./scanners.mjs";
import { discoverAccounts, floorTotals } from "./accounts.mjs";
import { readFleet, writeMachineFolder } from "./fleet.mjs";
import { collectProfileSignals, computeProfile } from "./profile.mjs";
import { renderStatsPage } from "./statspage.mjs";
import { startAudit, auditRead, auditWrite, finishAudit } from "./audit.mjs";
import { armTripwire } from "./tripwire.mjs";
import { runVerify, printVerify } from "./verify.mjs";
import { detectConfinement, buildProofCommand, sandboxProfile } from "./confine.mjs";

const BOLD = "\x1b[1m", DIM = "\x1b[2m", CYAN = "\x1b[36m", RESET = "\x1b[0m";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};
const fmt = (n) => (n ?? 0).toLocaleString("en-US");

// Subcommands are explicit. An unknown positional argument EXITS NON-ZERO
// rather than falling through to a scan — a proof command that silently runs
// something else and prints success would be worse than having none.
const KNOWN_SUBCOMMANDS = new Set(["scan", "verify", "prove"]);
const positional = args.filter((a) => !a.startsWith("-"));
const subcommand = positional[0] ?? "scan";
if (!KNOWN_SUBCOMMANDS.has(subcommand)) {
  console.error(
    `starforge: unknown command "${subcommand}". Expected one of: ${[...KNOWN_SUBCOMMANDS].join(", ")}.`
  );
  process.exit(2);
}

// `starforge verify` — the adversarial self-check. Runs the static scan, the
// audit chain, the output scrub, and the confinement report, and prints each
// check's limits underneath its result.
if (subcommand === "verify") {
  const results = runVerify();
  printVerify(results);
  process.exit(results.ok ? 0 : 1);
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
    console.log(`\nno OS confinement available here: ${e.message}`);
  }
  console.log(
    `\nfull scripted proof (scan in-sandbox + positive control):\n  sh ${maskPath(new URL("../bin/starforge-proof.sh", import.meta.url).pathname)}`
  );
  process.exit(0);
}

async function main() {
  // Armed before anything is read. The audit log is automatic; the tripwire is
  // a tripwire, not a boundary (see src/tripwire.mjs TRIPWIRE_LIMITS).
  const audit = startAudit(args);
  armTripwire(audit.recorder);

  console.log(`${BOLD}${CYAN}starforge${RESET} ${DIM}— local-only developer wrapped. Nothing leaves this machine.${RESET}\n`);

  const roots = [...defaultRoots(), ...(opt("roots")?.split(",").filter(Boolean) ?? [])];
  const sources = discoverSources(roots);
  if (sources.length === 0) {
    console.log("No AI-coding session logs found (looked for Claude Code, Cowork, Codex).");
    process.exit(1);
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
  let excludedPrefixes = [];
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
  let accounts = null;
  let fleetJoin = null;
  const joinDir = opt("join-fleet");
  if (flag("--accounts") || joinDir) {
    console.log(`\n${DIM}account scan: walking every Claude profile on this machine (can take minutes on big trees)…${RESET}`);
    try {
      const res = await discoverAccounts({ fleet: true });
      accounts = res.rows;
      fleetJoin = res;
    } catch (e) {
      console.log(`account scan failed: ${e.message}`);
    }
  }

  // ---- snapshots + velocity ------------------------------------------------
  if (!flag("--no-snapshot")) writeSnapshots(agg.monthly_buckets);
  const timeline = loadTimeline();
  const vel = velocity(timeline);

  // ---- summary -------------------------------------------------------------
  console.log(`\n${BOLD}── profile ─────────────────────────────${RESET}`);
  console.log(`sessions        ${fmt(agg.total_sessions)}  (${agg.active_days} active days, ${agg.total_duration_hours}h active)`);
  console.log(`tokens          ${fmt(agg.total_input_tokens + agg.total_output_tokens)} in+out, ${fmt(agg.total_cache_read_tokens + agg.total_cache_write_tokens)} cache`);
  console.log(`streak          ${agg.longest_streak_days}d longest, ${agg.current_streak_days}d current`);
  const topLangs = Object.entries(agg.languages).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topLangs.length) console.log(`languages       ${topLangs.map(([l, n]) => `${l}(${n})`).join(" ")}`);
  const topProj = agg.projects.slice(0, 5);
  if (topProj.length) console.log(`top projects    ${topProj.map((p) => p.name).join(", ")}`);
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
    for (const [acct, t] of [...byAcct.entries()].sort((a, b) => (b[1].floor ?? b[1].onDisk) - (a[1].floor ?? a[1].onDisk))) {
      console.log(
        `${acct.padEnd(36)} floor ${fmt(t.floor ?? t.onDisk).padStart(15)}   on disk ${fmt(t.onDisk).padStart(15)}`
      );
    }
    const fleet = floorTotals(accounts);
    const g = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;
    console.log(`${"MACHINE TOTAL".padEnd(36)} floor ${fmt(g(fleet.floor)).padStart(15)}   on disk ${fmt(g(fleet.onDisk)).padStart(15)}`);
  }

  if (vel && vel.months_tracked > 1) {
    console.log(`\n${BOLD}── velocity (${vel.months_tracked} months tracked) ──────${RESET}`);
    const s = (v, unit) => (v === null ? "n/a" : `${v > 0 ? "+" : ""}${v}${unit}`);
    console.log(`hours ${s(vel.hours_mom_pct, "%")} MoM   sessions ${s(vel.sessions_mom_pct, "%")} MoM   tokens ${s(vel.tokens_mom_pct, "%")} MoM   trend ${s(vel.hours_trend_per_month, "h/mo")}`);
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
      console.log(`fleet read failed: ${e.message}`);
    }
  }

  // ---- fleet join ----------------------------------------------------------
  if (joinDir && fleetJoin) {
    try {
      const providerSessions = (providers?.perSession ?? []).map((s) => ({
        cli: s.provider,
        session_id: s.session_id,
        account: s.account,
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
      const res = writeMachineFolder(joinDir, opt("machine") ?? "macbook-air-m1", {
        label: opt("label") ?? "MacBook Air M1",
        accounts: fleetJoin.fleetAccounts,
        sessions: [...fleetJoin.fleetSessions, ...providerSessions],
      });
      console.log(`\nfleet join: wrote ${maskPath(res.dir)} (${res.files.length} files, grand total ${fmt(res.grandTotal)})`);
      console.log(`${DIM}run his Python combine.py (or starforge --fleet=${maskPath(joinDir)}) to see the fleet with this Mac included${RESET}`);
    } catch (e) {
      console.log(`fleet join failed: ${e.message}`);
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
      console.log(`profile failed: ${e.message}`);
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
    writeFileSync(p1, auditWrite(audit, p1, JSON.stringify(baseline, null, 2)));
    writeFileSync(p2, auditWrite(audit, p2, JSON.stringify(expanded, null, 2)));
    console.log(`\nreports: ${maskPath(p1)}\n         ${maskPath(p2)}`);
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
    const html = renderStatsPage({
      profile,
      agg,
      accounts,
      fleet: fleetView,
      providers: providers?.providers ?? null,
      starSvg: cardSvg,
      velocity: vel,
      name,
    });
    const pagePath = join(outDir, `stats-${stamp}.html`);
    writeFileSync(pagePath, auditWrite(audit, pagePath, html));
    console.log(`page: ${maskPath(pagePath)} (open in any browser — computed locally, nothing uploaded)`);
  }

  const auditPath = finishAudit(audit);
  console.log(`\n${DIM}snapshots: ${maskPath(SNAP_DIR)} (sync this dir between machines to merge histories)${RESET}`);
  if (auditPath)
    console.log(`${DIM}run log:   ${maskPath(auditPath)} — verify it with \`starforge verify\`${RESET}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

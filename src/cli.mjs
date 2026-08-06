#!/usr/bin/env node
// starforge — privacy-first developer wrapped.
// Scans local AI-coding session logs, redacts + masks BEFORE storing anything,
// keeps rolling monthly snapshots, and renders your skill star live.
//
// Usage:
//   npx starforge                 scan with interactive exclusion prompts
//   npx starforge --yes           skip prompts (exclude nothing)
//   npx starforge --roots a,b     extra home roots (other accounts/machines)
//   npx starforge --json          write full JSON reports
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

const BOLD = "\x1b[1m", DIM = "\x1b[2m", CYAN = "\x1b[36m", RESET = "\x1b[0m";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};

async function main() {
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

  // ---- snapshots + velocity ------------------------------------------------
  if (!flag("--no-snapshot")) writeSnapshots(agg.monthly_buckets);
  const timeline = loadTimeline();
  const vel = velocity(timeline);

  // ---- summary -------------------------------------------------------------
  const fmt = (n) => n.toLocaleString("en-US");
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
  if (vel && vel.months_tracked > 1) {
    console.log(`\n${BOLD}── velocity (${vel.months_tracked} months tracked) ──────${RESET}`);
    const s = (v, unit) => (v === null ? "n/a" : `${v > 0 ? "+" : ""}${v}${unit}`);
    console.log(`hours ${s(vel.hours_mom_pct, "%")} MoM   sessions ${s(vel.sessions_mom_pct, "%")} MoM   tokens ${s(vel.tokens_mom_pct, "%")} MoM   trend ${s(vel.hours_trend_per_month, "h/mo")}`);
  }

  // ---- dual output ---------------------------------------------------------
  if (flag("--json")) {
    const outDir = join(homedir(), ".starforge", "reports");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    // 1) baseline: the compact standout-like stat block
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
    // 2) expanded: everything we computed — already redacted + path-masked
    const expanded = { generated_at: new Date().toISOString(), star_levels: Object.fromEntries(AXES.map((a, i) => [a, levels[i]])), ...agg, velocity: vel, timeline };
    const p1 = join(outDir, `baseline-${stamp}.json`);
    const p2 = join(outDir, `expanded-${stamp}.json`);
    writeFileSync(p1, JSON.stringify(baseline, null, 2));
    writeFileSync(p2, JSON.stringify(expanded, null, 2));
    console.log(`\nreports: ${maskPath(p1)}\n         ${maskPath(p2)}`);
  }
  console.log(`\n${DIM}snapshots: ${maskPath(SNAP_DIR)} (sync this dir between machines to merge histories)${RESET}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

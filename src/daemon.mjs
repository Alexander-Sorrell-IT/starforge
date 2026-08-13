// Optional scheduled re-scan.
//
// Why it exists: AI-coding logs age off disk (roughly 30 days), so a scan you
// run once shows one month and can never show more. Snapshots are the fix —
// they outlive the logs — but only if something takes them regularly. That is
// the whole job here: run the scan on a schedule so the monthly history keeps
// building instead of rolling off.
//
// Why it does NOT install itself: this module writes a plain-text schedule file
// and prints the ONE command that loads it. It never spawns launchctl, never
// edits a crontab behind your back, and never registers anything as a side
// effect of a normal scan. That is deliberate and it is the same principle the
// rest of the tool runs on — you can read the file before it is live, and the
// step that makes it live is a command you typed. A "privacy-first" tool that
// silently installs a background job that reads your disk every month would be
// arguing against itself.
//
// Nothing here is network-aware. The scheduled run is the same local scan, with
// --yes --no-pace, writing under ~/.starreckon exactly as an interactive run does.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "work.starreckon.scan";

const HOME = () => homedir();
const plistPath = () => join(HOME(), "Library", "LaunchAgents", `${LABEL}.plist`);
const systemdDir = () => join(HOME(), ".config", "systemd", "user");
const servicePath = () => join(systemdDir(), "starreckon-scan.service");
const timerPath = () => join(systemdDir(), "starreckon-scan.timer");

// The CLI entry point to schedule. Resolved from THIS file so a checkout and an
// installed package both schedule the copy you actually ran.
export function cliEntry() {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.mjs");
}

function esc(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
}

/**
 * The macOS launchd agent. StartCalendarInterval fires on the 1st of each month
 * at 09:00; launchd runs a missed job at next login rather than skipping it, so
 * a laptop that was asleep still gets its snapshot.
 */
export function launchdPlist({ node = process.execPath, entry = cliEntry(), day = 1, hour = 9 } = {}) {
  const logDir = join(HOME(), ".starreckon", "daemon");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(entry)}</string>
    <string>--yes</string>
    <string>--no-wrapped</string>
    <string>--no-pace</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Day</key><integer>${day}</integer>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${esc(join(logDir, "scan.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logDir, "scan.err"))}</string>
</dict>
</plist>
`;
}

export function systemdUnits({ node = process.execPath, entry = cliEntry() } = {}) {
  return {
    service: `[Unit]
Description=starreckon monthly local scan (no network)

[Service]
Type=oneshot
ExecStart=${node} ${entry} --yes --no-wrapped --no-pace
`,
    timer: `[Unit]
Description=Run starreckon monthly so snapshots outlive the ~30-day log retention

[Timer]
OnCalendar=monthly
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

export function daemonStatus() {
  const p = platform();
  if (p === "darwin") {
    const file = plistPath();
    return { platform: p, supported: true, installed: existsSync(file), file };
  }
  if (p === "linux") {
    return {
      platform: p, supported: true,
      installed: existsSync(timerPath()) && existsSync(servicePath()),
      file: timerPath(),
    };
  }
  return { platform: p, supported: false, installed: false, file: null };
}

/**
 * Write the schedule file(s). Returns { files, activate } — `activate` is the
 * command the USER runs to make it live. Nothing is loaded here.
 */
export function writeSchedule(opts = {}) {
  const p = platform();
  if (p === "darwin") {
    const file = plistPath();
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(join(HOME(), ".starreckon", "daemon"), { recursive: true });
    writeFileSync(file, launchdPlist(opts));
    return {
      files: [file],
      activate: `launchctl load ${file}`,
      deactivate: `launchctl unload ${file}`,
    };
  }
  if (p === "linux") {
    const dir = systemdDir();
    mkdirSync(dir, { recursive: true });
    const units = systemdUnits(opts);
    writeFileSync(servicePath(), units.service);
    writeFileSync(timerPath(), units.timer);
    return {
      files: [servicePath(), timerPath()],
      activate: "systemctl --user daemon-reload && systemctl --user enable --now starreckon-scan.timer",
      deactivate: "systemctl --user disable --now starreckon-scan.timer",
    };
  }
  return { files: [], activate: null, deactivate: null, unsupported: p };
}

/** Remove the schedule files. Returns the paths removed and the unload command. */
export function removeSchedule() {
  const st = daemonStatus();
  const removed = [];
  const files = st.platform === "linux" ? [timerPath(), servicePath()] : [plistPath()];
  for (const f of files) {
    if (existsSync(f)) {
      try { unlinkSync(f); removed.push(f); } catch {}
    }
  }
  return {
    removed,
    deactivate:
      st.platform === "linux"
        ? "systemctl --user disable --now starreckon-scan.timer"
        : `launchctl unload ${plistPath()}`,
  };
}

/** What a written schedule actually contains, for printing before it goes live. */
export function describeSchedule() {
  const st = daemonStatus();
  if (!st.supported) return null;
  if (!st.installed) return null;
  try {
    return readFileSync(st.file, "utf8");
  } catch {
    return null;
  }
}

// starreckon add-ons — optional companion tools, and the offline licence that
// unlocks them.
//
// WHAT THIS FILE IS ALLOWED TO DO, AND WHY IT IS SHAPED THIS WAY
//
// It reads the filesystem and verifies a signature. That is all. It imports
// node:fs, node:path, node:os and node:crypto and NOTHING else, which is the
// whole design constraint:
//
//   - No node:child_process. It never runs an add-on, it only reports whether
//     one COULD run. Spawning lives in cli.mjs, which already holds the single
//     written exemption for it (verify.mjs STATIC_ALLOWLIST). A new spawning
//     module here would need its own exemption, its own structural markers and
//     its own pin — three new promises to keep for something that belongs in
//     the file that already makes them.
//   - No network, of any kind. The licence is verified with local Ed25519
//     against a public key compiled into this file. Nothing is phoned home,
//     nothing is checked against a server, and no request is made when a
//     licence is missing, expired or forged. PROVE-IT.md's claim survives this
//     file unchanged, and that was a requirement rather than a nicety: the
//     no-egress proof is the most valuable thing this program owns, and an
//     entitlement check is not worth spending it.
//   - It never WRITES. The licence file is placed by the person who holds it.
//     PROVE-IT.md publishes an exhaustive list of what this program writes and
//     this file adds nothing to it.
//
// THE STATES, AND WHY THERE ARE FIVE OF THEM
//
// The single most repeated defect in this project's history is two different
// facts rendering as one number — usually as a silent zero. An add-on has more
// than two conditions and they are not interchangeable:
//
//   locked       the licence does not cover it. Nothing was looked for.
//   absent       covered, and no executable of that name is on PATH.
//   unreachable  covered, found on PATH, and the thing PATH points at is not
//                readable. This is not pedantry: all four pip tools here are
//                editable installs rooted on a REMOVABLE MOUNT, so "the drive
//                is unplugged" presents as a live PATH entry pointing at
//                nothing. Reporting that as `absent` would tell somebody to
//                reinstall a tool they already own.
//   ready        covered, present, readable.
//   external     covered and present, but starreckon will not run it — see
//                `runsHere: false` below.
//
// `absent` is never reported as an error and never as zero usage. A tool that
// is not installed is a fact about this machine, not a failure.

import { existsSync, readFileSync, statSync, lstatSync, accessSync, constants } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { createPublicKey, verify as edVerify } from "node:crypto";

// The issuer's Ed25519 public key, SPKI/DER, base64. Public by definition —
// it can only CHECK a signature, never create one. The matching private key is
// held by the issuer and is not in this repository, not in its history, and not
// in the published package.
//
// A client-side check is patchable by anyone who edits the file, and that is
// true of every client-side check ever written; it is a different axis from
// egress, and it is the axis this project can afford to lose. What it must not
// lose is the ability to prove nothing left the machine.
const ISSUER_PUBLIC_KEY_B64 =
  "MCowBQYDK2VwAyEARJgvRGgjNsv4fIN7hzwUWT7ZOo2Hla5f57E1KWMDsSs=";

/**
 * The companion tools, and how each one is actually found.
 *
 * `bin` IS NOT DERIVED FROM `pkg`. cli-wikia installs an executable called
 * `wikia`, and three of the four install one named after themselves. Deriving
 * the binary name from the package name produces exactly one false `absent`,
 * on exactly one tool, which is the kind of wrong that survives review.
 *
 * `runsHere: false` marks a tool starreckon will never execute itself. It is
 * not a lesser tier — it is a boundary. sitemap-mcp is an outbound HTTP client
 * by design (it fetches and outlines live sites), and starreckon's entire
 * verifiable claim is that nothing on its scan path opens a socket. Listing it
 * and refusing to run it keeps both facts true at once: the tool is yours, and
 * this program is still provably silent.
 */
export const ADDONS = Object.freeze([
  { name: "wikia", pkg: "cli-wikia", bin: "wikia", kind: "pip", runsHere: true,
    blurb: "offline reference wiki for the AI coding CLIs" },
  { name: "enforcement", pkg: "cli-enforcement", bin: "cli-enforcement", kind: "pip", runsHere: true,
    blurb: "hook-level behavioural enforcement, model-agnostic" },
  { name: "fleet", pkg: "cli-fleet", bin: "cli-fleet", kind: "pip", runsHere: true,
    blurb: "parallel enforced agent teams, coordinating over a shared mailbox" },
  { name: "collective", pkg: "cli-collective", bin: "cli-collective", kind: "pip", runsHere: true,
    blurb: "the whole stack in one install: wikia, enforcement, fleet" },
  { name: "filelens", pkg: "filelens-mcp", bin: "filelens-mcp", kind: "npx", runsHere: false,
    blurb: "MCP server — spawned by an MCP client over stdio, not by this CLI" },
  { name: "sitemap", pkg: "sitemap-mcp", bin: "sitemap-mcp", kind: "npx", runsHere: false,
    blurb: "MCP server — fetches live sites, so it never runs on the scan path" },
]);

/**
 * Search PATH for an executable, and report WHERE it looked.
 *
 * THE PATH IS RETURNED, NOT JUST THE ANSWER. All four pip tools live in a
 * virtualenv that is only on PATH when that environment is active, so the same
 * machine answers "installed" or "not installed" depending on how starreckon
 * was launched — from a shell with the venv active, from a desktop launcher,
 * or from a daemon with a minimal environment. An `absent` with no account of
 * where it looked is unactionable and, worse, looks definitive.
 *
 * NO EXECUTION. Availability is decided by the filesystem, never by running
 * the thing. filelens-mcp and sitemap-mcp parse no arguments whatsoever, so
 * the usual `--version` probe would hand them an argument they ignore and then
 * wait for a stdio MCP server to exit, which it will not do. A probe that can
 * hang is worse than no probe.
 */
export function locate(bin, env = process.env) {
  const raw = env.PATH ?? "";
  const dirs = raw.split(delimiter).filter(Boolean);
  for (const d of dirs) {
    const full = join(d, bin);
    // lstat, NOT existsSync. existsSync FOLLOWS symlinks, so a launcher whose
    // target has gone answers `false` and the entry is skipped as though it
    // were never there — which is exactly the `unreachable` case being
    // collapsed into `absent`, the distinction this function exists to make.
    // Caught by the dangling-symlink test, which failed on the first draft.
    try {
      lstatSync(full);
    } catch {
      continue;                            // genuinely nothing at this path
    }
    // Something IS here. Whether it can be run is a second question: an
    // editable install whose root has been unmounted leaves the launcher in
    // place and the target gone, and so does a broken symlink.
    try {
      statSync(full);                      // follows symlinks — throws if dangling
      accessSync(full, constants.X_OK);
      return { path: full, usable: true, searched: dirs };
    } catch {
      return { path: full, usable: false, searched: dirs };
    }
  }
  return { path: null, usable: false, searched: dirs };
}

export function licencePath(home) {
  return join(home ?? homedir(), ".starreckon", "licence.json");
}

/**
 * Read and verify the licence. Never throws, never writes, never connects.
 *
 * Returns a `status` that distinguishes every way this can go, because they
 * call for different actions and collapsing them is how a support question
 * becomes unanswerable:
 *
 *   none       no licence file. The ordinary state for most installs.
 *   malformed  a file is there and is not the shape of a licence.
 *   invalid    correctly shaped and the signature does not verify. Either it
 *              was edited, or it was not issued by the holder of the key.
 *   expired    genuinely issued, and its own end date has passed.
 *   valid      signed by the issuer and in date.
 *
 * `issuerKey` is injectable so the tests can exercise the VALID, EXPIRED and
 * signed-garbage paths without the issuer's private key existing anywhere near
 * this repository. It is not a hole: a client-side check runs on the reader's
 * own machine and can be edited outright, so an override parameter grants
 * nobody anything they did not already have, and it buys the valid path real
 * test coverage instead of none.
 *
 * `invalid` and `expired` are deliberately separate: one is a forgery and the
 * other is a customer whose renewal lapsed, and telling a paying customer that
 * their licence is forged is a worse mistake than the reverse.
 */
export function readLicence(home, { now = Date.now(), issuerKey = ISSUER_PUBLIC_KEY_B64 } = {}) {
  const file = licencePath(home);
  if (!existsSync(file)) return { status: "none", addons: [], file };

  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return { status: "malformed", addons: [], file,
             why: "not valid JSON" };
  }
  if (!doc || typeof doc.payload !== "string" || typeof doc.signature !== "string") {
    return { status: "malformed", addons: [], file,
             why: "expected an object with `payload` and `signature` strings" };
  }

  let ok = false;
  try {
    ok = edVerify(
      null,
      Buffer.from(doc.payload, "base64"),
      createPublicKey({
        key: Buffer.from(issuerKey, "base64"),
        format: "der", type: "spki",
      }),
      Buffer.from(doc.signature, "base64"),
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    return { status: "invalid", addons: [], file,
             why: "the signature does not match this build's issuer key" };
  }

  let claim;
  try {
    claim = JSON.parse(Buffer.from(doc.payload, "base64").toString("utf-8"));
  } catch {
    // Signed, and the signed bytes are not a claim. Treat as malformed rather
    // than valid-with-nothing: a verified signature over garbage must not read
    // as an entitlement to everything.
    return { status: "malformed", addons: [], file,
             why: "the signed payload is not valid JSON" };
  }

  const granted = Array.isArray(claim.addons) ? claim.addons.filter(x => typeof x === "string") : [];
  const expires = typeof claim.expires === "string" ? Date.parse(claim.expires) : NaN;
  if (!Number.isNaN(expires) && expires < now) {
    return { status: "expired", addons: [], file, subject: claim.subject ?? null,
             expires: claim.expires, why: "the licence's own end date has passed" };
  }
  return {
    status: "valid", file,
    subject: claim.subject ?? null,
    expires: claim.expires ?? null,
    // "*" grants everything, so a licence does not need reissuing when a new
    // companion tool ships.
    addons: granted.includes("*") ? ADDONS.map(a => a.name) : granted,
  };
}

/**
 * The full picture: every add-on, its entitlement, and its presence.
 *
 * Presence is looked up ONLY for entitled tools. Not as a technicality — an
 * unlicensed install should not be quietly inventorying what else is on the
 * machine, and `locked` genuinely means "nothing was looked for", which is a
 * more honest thing to print than a state that implies a search happened.
 */
export function survey(home, { env = process.env, now = Date.now(), issuerKey } = {}) {
  const lic = readLicence(home, issuerKey ? { now, issuerKey } : { now });
  const entitled = new Set(lic.addons);

  const rows = ADDONS.map((a) => {
    if (!entitled.has(a.name)) {
      return { ...a, state: "locked", path: null, searched: null };
    }
    const found = locate(a.bin, env);
    let state;
    if (!found.path) state = "absent";
    else if (!found.usable) state = "unreachable";
    else state = a.runsHere ? "ready" : "external";
    return { ...a, state, path: found.path, searched: found.searched };
  });

  return { licence: lic, addons: rows };
}

/** One line per add-on, plus the reason it is in that state. */
export function renderSurvey(s, { color = true } = {}) {
  const B = color ? "\x1b[1m" : "", D = color ? "\x1b[2m" : "", R = color ? "\x1b[0m" : "";
  const MARK = { ready: "ok", external: "ok", absent: "--", unreachable: "!!", locked: "--" };
  const NOTE = {
    ready: "installed and ready",
    external: "installed — run it from its own client, not from here",
    absent: "not installed on this machine",
    unreachable: "on PATH, but what PATH points at cannot be read",
    locked: "not covered by the licence on this machine",
  };

  const L = [];
  const lic = s.licence;
  const head = {
    none: "no licence file",
    malformed: `licence file unreadable — ${lic.why ?? ""}`,
    invalid: `licence not accepted — ${lic.why ?? ""}`,
    expired: `licence ended ${lic.expires ?? "?"}`,
    valid: `licensed to ${lic.subject ?? "(unnamed)"}${lic.expires ? ` until ${lic.expires}` : ""}`,
  }[lic.status];
  L.push(`${B}add-ons${R}  ${D}${head}${R}`);
  L.push("");

  const w = Math.max(...s.addons.map(a => a.name.length));
  for (const a of s.addons) {
    L.push(`  ${MARK[a.state]}  ${a.name.padEnd(w)}  ${D}${a.pkg} — ${a.blurb}${R}`);
    L.push(`      ${D}${NOTE[a.state]}${R}`);
    if (a.state === "unreachable") L.push(`      ${D}${a.path}${R}`);
  }
  L.push("");
  if (lic.status !== "valid") {
    L.push(`  ${D}A licence file goes at ${lic.file}${R}`);
  } else if (s.addons.some(a => a.state === "absent")) {
    const pipMissing = s.addons.filter(a => a.state === "absent" && a.kind === "pip");
    if (pipMissing.length) {
      L.push(`  ${D}pip tools are only on PATH inside their virtualenv — starreckon`);
      L.push(`  searched ${pipMissing[0].searched.length} PATH entries as launched${R}`);
    }
  }
  return L.join("\n");
}

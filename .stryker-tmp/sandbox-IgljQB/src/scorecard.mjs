// @ts-nocheck
// scorecard.mjs — self-submit scoreboard payload: sign your score,
// show the result to the user, let THEM decide what to share.
//
// WHAT THIS FILE DOES:
//   - buildPayload: assembles the scoreboard entry (counts + levels + tier +
//     archetype). NO paths, NO project names, NO prompt text, NO email address.
//   - signPayload:  signs the JSON payload with the fleet key so submissions
//     can be verified as coming from a real starreckon run.
//   - verifyPayload: checks a submission's signature (for the leaderboard).
//   - SUBMISSION_URL: the GitHub Pages URL where entries are manually posted.
//
// WHAT THIS FILE DOES NOT DO:
//   - No network of any kind.
//   - No writes other than what the caller requests.
//   - Nothing is uploaded automatically. The signed payload is shown to the
//     user; they copy it and submit it by hand.
//
// The submission format (v1):
// {
//   "v": 1,
//   "ts": "<ISO-8601 UTC>",       -- when this entry was signed
//   "tier": "FORGED",             -- one of the five forge-themed tiers
//   "archetype": "The Shipper",   -- from archetype.mjs
//   "total": 18.4,                -- sum of all 5 arm levels
//   "levels": {                   -- per-axis score (rounded to 1dp)
//     "FIRST PRINCIPLES": 4.2,
//     "ENGINEERING": 3.8,
//     ...
//   },
//   "sessions": 142,
//   "active_days": 38,
//   "longest_streak_days": 12,
//   "tokens_in_out": 142000000,   -- combined input + output (no cache)
//   "pub": "<base64>",            -- raw 32-byte Ed25519 public key
//   "sig": "<base64>"             -- Ed25519 signature over the payload bytes (excluding sig itself)
// }

import { signPayload as _sign, verifyPayload as _verify } from "./fleetkey.mjs";
import { rating }     from "./archetype.mjs";
import { archetype }  from "./archetype.mjs";
import { AXES }       from "./starsvg.mjs";

// The GitHub Issues URL for leaderboard submissions.
// Use GitHub Issues rather than Pages+JS for the MVP: zero infra, fully manual,
// the user pastes the signed JSON into an issue and it appears on the board.
export const SUBMISSION_URL =
  "https://github.com/Alexander-Sorrell-IT/starreckon/issues/new?template=scoreboard.md&title=Scoreboard+submission";

export const LEADERBOARD_URL =
  "https://github.com/Alexander-Sorrell-IT/starreckon/issues?q=is%3Aissue+label%3Ascoreboard";

/**
 * Build the scoreboard payload from scan data.
 * Returns a plain object — caller signs it with signScorecard().
 *
 * levels  — 5-element array (AXES order)
 * agg     — finalize() aggregate (total_sessions, active_days, …)
 * pub     — 32-byte Buffer — the fleet key public bytes (for verification)
 */
export function buildPayload(levels, agg, pub) {
  const total = levels.reduce((a, b) => a + b, 0);
  const tier  = rating(total);
  const arc   = archetype(levels);
  return {
    v:                   1,
    ts:                  new Date().toISOString(),
    tier,
    archetype:           arc.name,
    total:               +total.toFixed(1),
    levels:              Object.fromEntries(AXES.map((ax, i) => [ax, +Number(levels[i] ?? 0).toFixed(1)])),
    sessions:            agg.total_sessions          ?? 0,
    active_days:         agg.active_days             ?? 0,
    longest_streak_days: agg.longest_streak_days     ?? 0,
    tokens_in_out:       (agg.total_input_tokens ?? 0) + (agg.total_output_tokens ?? 0),
    pub:                 pub ? pub.toString("base64") : null,
  };
}

/**
 * Sign the scorecard payload with the fleet private key.
 * Returns { payload, sig } where both are base64 strings.
 * `payload` is the canonical JSON bytes that were signed.
 *
 * The payload field order is deterministic (insertion order in buildPayload),
 * so the same inputs always produce the same bytes and the signature is stable.
 */
export function signScorecard(payloadObj, privateKeyObj) {
  // Remove any existing sig before signing (so verification is consistent).
  const { sig: _dropped, ...clean } = payloadObj;
  const bytes = Buffer.from(JSON.stringify(clean));
  const sigBuf = _sign(privateKeyObj, bytes);
  return {
    payload: bytes.toString("base64"),
    sig:     sigBuf.toString("base64"),
  };
}

/**
 * Verify a signed scorecard submission.
 * Returns true if the signature is valid over the payload bytes.
 *
 * pubBytes  — 32-byte Buffer (raw Ed25519 public key)
 * payload   — base64 string (the signed bytes)
 * sig       — base64 string (Ed25519 signature)
 */
export function verifyScorecard(pubBytes, payload, sig) {
  try {
    const payloadBuf = Buffer.from(payload, "base64");
    const sigBuf     = Buffer.from(sig, "base64");
    return _verify(pubBytes, payloadBuf, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Render the scoreboard entry as a human-readable block the user can copy.
 * Returns a plain text string — no ANSI codes.
 */
export function renderScorecard(payloadObj, sig) {
  const lines = [];
  lines.push("── starreckon scoreboard entry ─────────────────────────────");
  lines.push(`tier       ${payloadObj.tier}`);
  lines.push(`archetype  ${payloadObj.archetype}`);
  lines.push(`total      ${payloadObj.total} / ${AXES.length * 7}`);
  for (const [ax, lv] of Object.entries(payloadObj.levels ?? {})) {
    lines.push(`  ${ax.padEnd(18)} ${lv}`);
  }
  lines.push(`sessions   ${(payloadObj.sessions ?? 0).toLocaleString("en-US")}`);
  lines.push(`active days ${payloadObj.active_days ?? 0}`);
  lines.push(`streak     ${payloadObj.longest_streak_days ?? 0}d`);
  lines.push(`tokens     ${((payloadObj.tokens_in_out ?? 0) / 1e6).toFixed(1)}M in+out`);
  lines.push(`signed     ${payloadObj.ts}`);
  if (sig) lines.push(`sig        ${sig.slice(0, 16)}… (${sig.length} chars)`);
  lines.push("─────────────────────────────────────────────────────────────");
  return lines.join("\n");
}

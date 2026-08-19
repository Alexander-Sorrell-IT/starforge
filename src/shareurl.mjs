// shareurl.mjs — encode star results into a fragment URL for GitHub Pages.
//
// The URL carries the results in the hash fragment so nothing is sent to any
// server — the GitHub Pages page reads window.location.hash client-side and
// renders the star from those numbers. No upload, no account, works for every
// user of the published package.
//
// URL shape:
//   https://alexander-sorrell-it.github.io/starreckon/#s=23.1&g=MASTERWORK&
//     a=DEEP_BUILDER&v=4.8,4.6,4.5,4.7,4.4&ss=142&h=318&d=89&k=21&n=Name
//
// Parameters:
//   s   total skill points (1 decimal)
//   g   tier name (MASTERWORK/TEMPERED/FORGED/CAST/RAW)
//   a   archetype name
//   v   axis levels, comma-separated, 1 decimal each (AXES order)
//   ss  total sessions (integer)
//   h   active hours rounded (integer)
//   d   active days (integer)
//   k   longest streak days (integer, omitted if 0)
//   n   display name (optional, from --name)
//
// The fragment is never sent to the server — it stays in the browser.
// Verified by: the URL is built entirely from local scan results; no outbound
// request is made by this module. The GitHub Pages page is a static file.

import { AXES, ARMS, MAX_LEVEL } from "./starsvg.mjs";
import { archetype, rating } from "./archetype.mjs";
import { FIELDS as CONTACT_FIELDS } from "./contact.mjs";

export const PAGES_BASE = "https://alexander-sorrell-it.github.io/starreckon/";

// The QR payload cap. contact.mjs documents the same 260 bytes for the raw-text
// payload; the URL is held to it too so a scannable code stays scannable.
export const QR_BUDGET_BYTES = 260;

// Short URL keys for the contact fields. Deliberately terse: every byte spent
// on a key name is a byte not available for a value inside the QR budget.
const URL_KEYS = {
  name: "n", github: "gh", email: "em", phone: "tel",
  website: "web", linkedin: "li", twitter: "tw",
};

/**
 * Build the share URL for a set of scan results.
 * Returns a string URL, or null if the inputs are missing.
 *
 * levels  — array of ARMS numbers (0..MAX_LEVEL)
 * agg     — the finalize() aggregate object
 * contact — the contact object from contact.json (a bare string is
 *           accepted and treated as the name). Only fields that are set
 *           are added, in priority order, within the byte budget.
 * budget  — max URL bytes. Defaults to the QR cap.
 */
export function buildShareUrl(levels, agg, contact, budget = QR_BUDGET_BYTES) {
  if (!levels || !levels.length) return null;
  const lv = levels.map((v) => Math.min(MAX_LEVEL, Math.max(0, +v || 0)));
  const total = +lv.reduce((a, b) => a + b, 0).toFixed(1);
  const tier = rating(total);
  const arch = archetype(lv);

  const params = new URLSearchParams();
  params.set("s", total.toFixed(1));
  params.set("g", tier);
  params.set("a", arch.name.replace(/\s+/g, "_"));
  params.set("v", lv.map((x) => x.toFixed(1)).join(","));
  if (agg) {
    const a = agg;
    params.set("ss", String(a.total_sessions ?? 0));
    params.set("h", String(Math.round(a.total_duration_hours ?? 0)));
    params.set("d", String(a.active_days ?? 0));
    if (a.longest_streak_days) params.set("k", String(a.longest_streak_days));
  }
  // CONTACT RIDES IN THE URL, so the QR stays a clickable link a phone can
  // open AND carries what the [R] screen says it carries. Before this, the
  // contact block was only reachable through `sharePayload`, and that call
  // (wrapped.mjs) was DEAD: it sat behind `buildShareUrl(...) ?? sharePayload(...)`
  // and buildShareUrl only returns null for an empty levels array, which lv5()
  // can never produce. So every field typed into "reach out (shown in QR)" was
  // written to disk and shown nowhere.
  //
  // A string is still accepted for `contact` and treated as the name, so older
  // callers keep working.
  //
  // BUDGET: fields are added in CONTACT_FIELDS priority order (name first) and a
  // field whose param would push the URL past `budget` bytes is SKIPPED, never
  // truncated — the same rule contactLines() uses. Half an email address is
  // worse than no email address.
  const ct = typeof contact === "string" ? { name: contact } : (contact ?? {});
  for (const f of CONTACT_FIELDS) {
    const raw = ct[f];
    if (!raw || typeof raw !== "string" || !raw.trim()) continue;
    const key = URL_KEYS[f];
    if (!key) continue;
    // 32, matching the name cap this file already had and shareurl.test.mjs
    // asserts. Uniform across fields: one number is easier to reason about
    // against the byte budget than a per-field table.
    const val = raw.trim().slice(0, 32);
    // MEASURE WHAT IS ACTUALLY WRITTEN. This estimated the cost with
    // encodeURIComponent and then wrote with params.set(), and the two do not
    // agree: encodeURIComponent leaves ! ( ) ~ \' unescaped at 1 byte each while
    // URLSearchParams percent-encodes them at 3. The estimate UNDER-counted, so
    // a name like O\'Brien (Alex) could push the URL past a cap the check said
    // it was under. Set it, measure the real string, and take it back out if it
    // does not fit — the only number that cannot drift from the output is the
    // output.
    params.set(key, val);
    if (Buffer.byteLength(PAGES_BASE + "#" + params.toString(), "utf8") > budget) {
      params.delete(key);
      // continue, not break: this matches contactLines() in contact.mjs, which
      // also skips an over-budget field and keeps going. A short later field
      // still fits where a long earlier one did not, so the QR carries more.
      continue;
    }
  }
  return PAGES_BASE + "#" + params.toString();
}

/**
 * Parse a share URL fragment back into an object.
 * Used by the GitHub Pages index.html (via inline script, not this module).
 * Exported here so it can be unit-tested.
 */
export function parseShareUrl(url) {
  try {
    const hash = url.includes("#") ? url.split("#")[1] : url;
    const p = new URLSearchParams(hash);
    const raw = p.get("v");
    if (!raw) return null;
    const v = raw.split(",").map(Number).filter((n) => !isNaN(n));
    if (!v.length) return null;
    return {
      total:    parseFloat(p.get("s") ?? "0"),
      tier:     p.get("g") ?? "",
      archetype: (p.get("a") ?? "").replace(/_/g, " "),
      levels:   v,
      sessions: parseInt(p.get("ss") ?? "0", 10),
      hours:    parseInt(p.get("h") ?? "0", 10),
      days:     parseInt(p.get("d") ?? "0", 10),
      streak:   parseInt(p.get("k") ?? "0", 10),
      name:     p.get("n") ?? null,
      // A URL that encodes six contact fields and parses back one is not a
      // round trip. This returned only `name`, so github/email/phone/website/
      // linkedin/twitter were silently dropped by every consumer that reads a
      // shared link back. Derived from URL_KEYS so adding a field cannot
      // desynchronise the two halves again.
      contact:  Object.fromEntries(
        Object.entries(URL_KEYS)
          .map(([field, key]) => [field, p.get(key)])
          .filter(([, val]) => val != null && val !== "")
      ),
    };
  } catch {
    return null;
  }
}

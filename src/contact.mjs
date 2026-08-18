// Contact info — the optional block shown in the QR and on the Share card.
//
// Storage: ~/.starreckon/contact.json. That file is NEVER written by a scan or
// by any automatic process — only by the [C] menu in the terminal, or by the
// user editing it directly. That keeps the privacy contract intact: starreckon
// never collects contact info, you opt in by creating the file.
//
// The fields are deliberate: name, github, email, phone, website, linkedin,
// twitter. `name` lives HERE and not behind a --name flag: a flag is retyped
// every run, is invisible to the [R] screen that claims to show what is
// shared, and bypassed the opt-in contract below. One place owns identity.
// No freeform keys. A controlled set means the QR serialiser knows every tag
// prefix and the menu knows every prompt, and neither has to handle unknowns.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Canonical field order — also the priority order for QR packing (most
// important first, so if the payload is tight the useful fields survive).
export const FIELDS = ["name", "github", "email", "phone", "website", "linkedin", "twitter"];

// Short tag prefix for each field in the QR payload. Kept as short as possible
// to maximise how much fits in the 260-byte cap.
export const TAGS = {
  name:     "",
  github:   "gh:",
  email:    "em:",
  phone:    "tel:",
  website:  "web:",
  linkedin: "li:",
  twitter:  "tw:",
};

// Human label for each field — used in the terminal menu.
export const LABELS = {
  name:     "Name",
  github:   "GitHub",
  email:    "Email",
  phone:    "Phone",
  website:  "Website",
  linkedin: "LinkedIn",
  twitter:  "Twitter/X",
};

// Menu key bindings — single letter, unique, shown in [brackets].
export const KEYS = {
  N: "name",
  G: "github",
  E: "email",
  P: "phone",
  W: "website",
  L: "linkedin",
  T: "twitter",
};

export function contactPath(home) {
  return join(home ?? homedir(), ".starreckon", "contact.json");
}

/**
 * Read ~/.starreckon/contact.json. Returns {} when absent or unparseable.
 * Only the known FIELDS keys are kept — unknown keys from manual edits are
 * silently dropped rather than propagated (they would show up in the QR as
 * unrecognised garbage, and nothing in the menu knows how to display them).
 */
export function readContact(home) {
  const file = contactPath(home);
  if (!existsSync(file)) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const f of FIELDS) {
    const v = raw[f];
    if (typeof v === "string" && v.trim()) out[f] = v.trim();
  }
  return out;
}

/**
 * Write a contact object back to ~/.starreckon/contact.json.
 * Passing an empty object (or one with no non-empty fields) deletes the file.
 * Only FIELDS keys are written — anything else is stripped.
 */
export function writeContact(home, obj) {
  const file = contactPath(home);
  const clean = {};
  for (const f of FIELDS) {
    const v = (obj ?? {})[f];
    if (typeof v === "string" && v.trim()) clean[f] = v.trim();
  }
  if (Object.keys(clean).length === 0) {
    if (existsSync(file)) unlinkSync(file);
    return;
  }
  mkdirSync(join(home ?? homedir(), ".starreckon"), { recursive: true });
  writeFileSync(file, JSON.stringify(clean, null, 2) + "\n", "utf8");
}

/**
 * Build the lines that go into the QR payload for contact fields.
 *
 * Each line is "TAG:value". Lines are packed in FIELDS priority order.
 * A field whose line would push the total past `budget` bytes is skipped
 * entirely — never truncated mid-value, because a half-email is worse than
 * no email. Returns an array of strings (may be empty).
 */
export function contactLines(contact, budget) {
  const enc = new TextEncoder();
  const lines = [];
  let used = 0;
  for (const f of FIELDS) {
    const v = (contact ?? {})[f];
    if (!v) continue;
    const line = TAGS[f] + v;
    const bytes = enc.encode(line + "\n").length;
    if (used + bytes > (budget ?? Infinity)) continue; // skip, never truncate mid-value
    lines.push(line);
    used += bytes;
  }
  return lines;
}

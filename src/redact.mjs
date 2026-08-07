// Credential redaction + path masking + identity pseudonymisation. Everything
// passes through here BEFORE it is stored, rendered, or written to any report
// file.
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";

export const REDACTED = "[redacted]";

// Superset of the standout regex list, plus env-style assignments, ssh keys,
// hex secrets, connection-string passwords, and cloud tokens.
const SECRET_PATTERNS = [
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  /ssh-(?:rsa|ed25519|dss|ecdsa)\s+[A-Za-z0-9+/=]{40,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  /npm_[A-Za-z0-9]{36}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{60,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ASIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /ya29\.[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, // JWT
  /dg_[A-Za-z0-9]{30,}/g, // Deepgram
  /hf_[A-Za-z0-9]{30,}/g, // HuggingFace
  /pk_(?:live|test)_[A-Za-z0-9]{20,}/g,
  /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/g, // conn-string password
  /mysql:\/\/[^:\s]+:[^@\s]+@/g,
  /mongodb(?:\+srv)?:\/\/[^:\s]+:[^@\s]+@/g,
  /redis:\/\/[^:\s]*:[^@\s]+@/g,
  /0x[a-fA-F0-9]{64}\b/g, // 32-byte hex (eth private keys etc.)
  // RFC1918 addresses. Not a credential, but an internal host is infrastructure
  // detail about someone's network, and a wrapped is a thing people post. Found
  // in a sibling tool's corpus as `Login path (PuTTY/MobaXterm -> 10.x.x.x ->
  // ssh <account>@)`, which survived every rule above because none describe an
  // IP. Private ranges only: a public address is indistinguishable from a
  // version string or an ordinary number, and matching those would redact prose.
  /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
];

// KEY=value / key: value / "key": "value" style assignments.
const LABELED_SECRET =
  /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi;

// ENV-style: SOMETHING_KEY=longvalue, SOMETHING_TOKEN=..., SOMETHING_SECRET=...
const ENV_SECRET =
  /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH))=(["']?)([^\s"']{8,})\2/g;

export function redactSecrets(text) {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(LABELED_SECRET, (_m, label, sep) => `${label}${sep}${REDACTED}`);
  out = out.replace(ENV_SECRET, (_m, name) => `${name}=${REDACTED}`);
  return out;
}

// ---- path masking ----------------------------------------------------------
const HOME = homedir();
let USER = "";
try {
  USER = userInfo().username;
} catch {
  USER = process.env.USER || "";
}

// A username shorter than this is not masked outside an explicit /user/ path:
// names like "al" or "dev" appear in ordinary words, and replacing them would
// corrupt text without protecting anyone. src/verify.mjs's output-scrub check
// imports this same constant, so what maskPath REMOVES and what the scrub
// FLAGS can never drift apart.
export const MIN_MASKABLE_USER_LEN = 4;

// Mask the home dir, the username anywhere it appears, and collapse deep local
// paths so only the project-relative tail survives.
//
// The third rule (a standalone occurrence of the username, whatever the
// surrounding punctuation) exists because slash-delimited masking is not
// enough: paths get MANGLED into single directory names, with "/" rewritten to
// something else, and the username rides along. Claude Code does exactly this —
// ~/.claude/projects/-Users-alice-Desktop-Bug — and that is a tree starforge
// reads on every run. A found leak, not a hypothetical: a real run log here
// recorded `--join-fleet=/private/tmp/.../-Users-<name>-.../token-usage`, which
// the first two rules left untouched and the output-scrub check then flagged as
// a masking failure in our own output.
//
// The cost is a false positive: if your username is also an ordinary word, that
// word becomes [user] in report text. For a tool whose whole claim is that it
// does not write your identity into files people sync, that is the right way to
// be wrong.
export function maskPath(p) {
  if (!p || typeof p !== "string") return p;
  let out = p;
  if (HOME) out = out.split(HOME).join("~");
  if (USER) {
    out = out.replace(
      new RegExp(`/(?:Users|home)/${escapeRe(USER)}(?=/|$)`, "g"),
      "~"
    );
    out = out.split(`/${USER}/`).join("/[user]/");
    if (USER.length >= MIN_MASKABLE_USER_LEN)
      out = out.replace(
        new RegExp(`(?<![A-Za-z0-9])${escapeRe(USER)}(?![A-Za-z0-9])`, "g"),
        "[user]"
      );
  }
  return out;
}

// Reduce a cwd to a masked project label: last two path segments under ~.
//
// TWO BUGS LIVED HERE, and both wrote their canary into reports/expanded-*.json
// verbatim while profile.mjs redacted the SAME label three hundred lines away —
// so one generated file contained "[redacted]/repo" and the live value side by
// side.
//
//   1. maskPath only. maskPath rewrites HOME, and nothing else; a secret sitting
//      in a working-directory name is not a path component it knows about. A cwd
//      whose second-to-last segment was an AWS key id produced exactly that key
//      as the project name. redactSecrets has to run too, and it runs FIRST so
//      that a key is gone before any truncation decision is made about it.
//      (No example path here on purpose: this file is scanned for anything
//      home-shaped, and a comment is as readable as code.)
//
//   2. split("/") only. A Windows or UNC cwd has no forward slashes, so it is
//      one "segment", so the <= 2 early return handed back the WHOLE path:
//      "C:\Users\<person>\Projects\<client>" and "\\fileserver\share\<matter>"
//      were written in full, and unescaped into title= attributes in the HTML.
//      Splitting on both separators makes the two-segment rule mean the same
//      thing on every platform, which is what it always claimed to mean.
export function projectLabel(cwd) {
  const masked = maskPath(redactSecrets(cwd));
  if (!masked) return null;
  const parts = masked.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return masked;
  return parts.slice(-2).join("/");
}

export function maskText(text) {
  if (!text) return text;
  let out = redactSecrets(text);
  out = maskPath(out);
  return out;
}

// ---- identity pseudonymisation ---------------------------------------------
// An account identity (the Claude OAuth email address, or the userID tier) is
// not a "secret" in the redactSecrets sense — it is the user's NAME, and none
// of the 25+ patterns above match an email. It must not land in a file
// starforge writes, because reports, the stats page and a --join-fleet folder
// are all things people sync and share.
//
// The replacement is a pseudonym, not [redacted], because the identity is also
// a GROUPING KEY: per-account totals, the floor metric, and cross-machine fleet
// merges all break if two accounts collapse into one label. accountPseudonym is
// therefore deterministic and machine-independent — the same address yields the
// same label on every machine — and collision-resistant, unlike an initial-plus-
// domain mask ("a***@gmail.com"), which silently merges two accounts that share
// a first letter and a provider.
//
// HONEST LIMIT (printed by `starforge verify` and stated in the README): this
// is a constant-salted SHA-256 prefix. It stops a reader of the file from
// READING your address; it does not stop someone who already suspects an
// address from CONFIRMING it by hashing their guess. It is de-identification,
// not anonymity. Raw identities are available on purpose via --show-accounts.
const PSEUDONYM_SALT = "starforge-account-v1:";

export function accountPseudonym(identity) {
  return (
    "acct-" +
    createHash("sha256")
      .update(PSEUDONYM_SALT + String(identity ?? ""))
      .digest("hex")
      .slice(0, 8)
  );
}

// ---- project pseudonymisation (--no-projects) -------------------------------
// A project label is the last two segments of a working directory, so a report
// is a legible list of what you work on: for a contractor or a bug-bounty
// hunter that is a CLIENT LIST, and it sits in a file people sync. It is kept
// readable BY DEFAULT because it is most of the report's value, and it is
// disclosed in the printed limits, the terminal, the page footer and the
// README — but a user who wants the numbers without the names needs a way to
// say so that does not depend on typing every folder into the exclusion prompt
// (which `--yes` skips entirely).
//
// Same reasoning as accountPseudonym: a stable hash, not [redacted], because
// the label is a GROUPING KEY — per-project counts must survive it.
const PROJECT_SALT = "starforge-project-v1:";

export function projectPseudonym(label) {
  return (
    "proj-" +
    createHash("sha256")
      .update(PROJECT_SALT + String(label ?? ""))
      .digest("hex")
      .slice(0, 8)
  );
}

// Strings that are already anonymous: the exclusion sentinel and anything else
// bracketed by the masking layer. Hashing them would only make output harder to
// read for no gain.
const isSentinel = (s) => s.startsWith("[") && s.endsWith("]");

// Collect every project label in a structure, then replace all of them.
//
// Two passes on purpose. Labels appear under two different shapes —
// `projects[].name` and a bare `project:` field (verified against a real
// expanded report: $.projects[].name, $.profile.projects[].name and
// $.profile.records.*.project) — and a label found under ONE shape must be
// replaced under EVERY shape, or the same project stays readable in the other
// place. Collect-then-replace makes that automatic and makes the result
// checkable: the caller can assert no collected label survives.
export function collectProjectLabels(node, out = new Set(), key = null, depth = 0) {
  if (depth > 20) return out;
  if (typeof node === "string") {
    if (key === "project" && node && !isSentinel(node)) out.add(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectProjectLabels(v, out, key, depth + 1);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      // projects: [{ name, ... }] — the name IS the label
      if (k === "projects" && Array.isArray(v)) {
        for (const item of v)
          if (item && typeof item.name === "string" && !isSentinel(item.name))
            out.add(item.name);
      }
      collectProjectLabels(v, out, k, depth + 1);
    }
  }
  return out;
}

// Returns a COPY with every collected label replaced by its pseudonym. The
// input is never mutated: the terminal has already printed the real names by
// the time this runs, and a shared object being rewritten under it would be a
// bug waiting to happen.
export function maskProjects(node, labels = null, depth = 0) {
  const set = labels ?? collectProjectLabels(node);
  const walk = (n, d) => {
    if (d > 20) return n;
    if (typeof n === "string") return set.has(n) ? projectPseudonym(n) : n;
    if (Array.isArray(n)) return n.map((v) => walk(v, d + 1));
    if (n && typeof n === "object") {
      const out = {};
      for (const [k, v] of Object.entries(n)) out[k] = walk(v, d + 1);
      return out;
    }
    return n;
  };
  return walk(node, depth);
}

// Email addresses in free text. Kept as a source string (not a shared /g
// RegExp object) so no caller can be bitten by a stale lastIndex.
const EMAIL_SRC =
  "[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\\.[A-Za-z]{2,}";

export function emailRe(flags = "g") {
  return new RegExp(EMAIL_SRC, flags);
}

// First email-shaped string in `text`, with its offset — used by the verify
// output-scrub check to point at the exact line.
export function findEmail(text) {
  if (!text || typeof text !== "string") return null;
  const m = emailRe().exec(text);
  return m ? { value: m[0], index: m.index } : null;
}

// Replace every email address in free text with its stable pseudonym.
export function maskIdentities(text) {
  if (!text || typeof text !== "string") return text;
  return text.replace(emailRe(), (m) => accountPseudonym(m));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Credential redaction + path masking. Everything passes through here BEFORE
// it is stored, rendered, or written to any report file.
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

// Mask the home dir, the username anywhere it appears in a path, and collapse
// deep local paths so only the project-relative tail survives.
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
  }
  return out;
}

// Reduce a cwd to a masked project label: last two path segments under ~.
export function projectLabel(cwd) {
  const masked = maskPath(cwd);
  if (!masked) return null;
  const parts = masked.split("/").filter(Boolean);
  if (parts.length <= 2) return masked;
  return parts.slice(-2).join("/");
}

export function maskText(text) {
  if (!text) return text;
  let out = redactSecrets(text);
  out = maskPath(out);
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

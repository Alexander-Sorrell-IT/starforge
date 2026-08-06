// starforge verify — the user-run warden.
//
// Four checks, each reported with its LIMITS printed underneath, because every
// one of them is weaker than it sounds and the honest move is to say exactly
// how. The real no-egress proof is not in this file at all: it is the OS
// confinement command this file prints (see confine.mjs and PROVE-IT.md §1).
//
// Checks:
//   1. static-scan   — text scan of the source tree for network/process APIs;
//                      exactly two files are allowlisted, by name, with reasons.
//   2. audit-chain   — the hash-chained run log is intact and records zero
//                      tripwire hits.
//   3. output-scrub  — nothing under ~/.starforge leaks the real home dir,
//                      username, secret-shaped strings, or transcript-sized text.
//   4. confinement   — is OS-level confinement AVAILABLE here, and what exact
//                      command gives the real proof. Availability is not a claim
//                      that any past run was confined.
//
// Exit codes (when run as `node src/verify.mjs`):
//   0 = every check passed
//   1 = at least one check FAILED
//   2 = verify itself crashed
//
// Self-scan note: this file is scanned by its own check #1, so every pattern
// below is assembled from string fragments at runtime — the forbidden tokens
// never appear verbatim in this file. tests/verify.test.mjs pins that.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, relative, basename, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactSecrets, maskPath } from "./redact.mjs";
import { verifyAuditChain, AUDIT_DIR, AUDIT_LIMITS } from "./audit.mjs";
import { detectConfinement, buildProofCommand } from "./confine.mjs";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const BOLD = "\x1b[1m", DIM = "\x1b[2m", CYAN = "\x1b[36m",
  GREEN = "\x1b[32m", RED = "\x1b[31m", RESET = "\x1b[0m";

// ---- check 1: static source scan -------------------------------------------
// The ONLY two files allowed to reference network/process APIs, each with the
// reason stated. A hit anywhere else fails; an allowlisted file with ZERO hits
// also fails — that means its safety code was gutted (or the file is gone).
export const STATIC_ALLOWLIST = Object.freeze({
  "tripwire.mjs":
    "imports the network modules solely to patch them into throwers (a tripwire for accidental egress — not a boundary)",
  "confine.mjs":
    "the OS-sandbox launcher (spawns the CONFINED child) plus the positive-control egress attempt the kernel must refuse",
});

// Pattern fragments joined at runtime so this file never contains the tokens
// it hunts (see self-scan note in the header).
const CP = "child" + "_process";
const WT = "worker" + "_threads";
const MOD_ALT = ["net", "https?", "dns", "tls", "dgram", CP, WT].join("|");

const RULES = [
  {
    api: "node builtin network/process-spawning module",
    re: new RegExp(`["'\`]node:(?:${MOD_ALT})["'\`]`),
  },
  {
    api: "bare network/process-spawning module specifier",
    re: new RegExp(
      `(?:\\bfrom\\s*|\\breq` + `uire\\s*\\(\\s*|\\bimp` + `ort\\s*\\(\\s*)["'\`](?:${MOD_ALT})["'\`]`
    ),
  },
  { api: "fet" + "ch()", re: new RegExp("\\bfet" + "ch\\s*\\(") },
  { api: "Web" + "Socket", re: new RegExp("\\bWeb" + "Socket\\b") },
  { api: "XMLHt" + "tpRequest", re: new RegExp("\\bXMLHt" + "tpRequest\\b") },
  { api: "ev" + "al()", re: new RegExp("\\bev" + "al\\s*\\(") },
  { api: "new Fun" + "ction()", re: new RegExp("\\bnew\\s+Fun" + "ction\\b") },
  {
    api: "process-level binding access (below the JS layer)",
    re: new RegExp("\\bprocess\\s*\\.\\s*bind" + "ing\\b"),
  },
];

// Non-literal dynamic loading is a hard FAIL everywhere, allowlist included:
// a variable specifier means the scan cannot know what gets loaded.
const HARD_RULES = [
  {
    api: "dynamic module load with a non-literal specifier",
    re: new RegExp("\\bimp" + "ort\\s*\\(\\s*[^\"'`)\\s]"),
  },
  {
    api: "dynamic module load with a template-interpolated specifier",
    re: new RegExp("\\bimp" + "ort\\s*\\(\\s*`[^`]*\\$\\{"),
  },
  {
    api: "req" + "uire() with a non-literal specifier",
    re: new RegExp("\\breq" + "uire\\s*\\(\\s*[^\"'`)\\s]"),
  },
  {
    api: "req" + "uire() with a template-interpolated specifier",
    re: new RegExp("\\breq" + "uire\\s*\\(\\s*`[^`]*\\$\\{"),
  },
];

function* mjsFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* mjsFiles(p);
    else if (name.endsWith(".mjs")) yield p;
  }
}

export function staticScan(srcDir = SRC_DIR) {
  const findings = [];
  const allowlist = {};
  for (const [file, reason] of Object.entries(STATIC_ALLOWLIST))
    allowlist[file] = { reason, hits: 0 };

  let files = [];
  try {
    files = [...mjsFiles(srcDir)];
  } catch (e) {
    findings.push(`cannot read source dir ${maskPath(srcDir)}: ${e.message}`);
  }

  for (const file of files) {
    const base = basename(file);
    const rel = relative(srcDir, file) || base;
    let lines = [];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch (e) {
      findings.push(`${rel}: unreadable (${e.message})`);
      continue;
    }
    lines.forEach((line, i) => {
      for (const r of HARD_RULES) {
        if (r.re.test(line))
          findings.push(
            `${rel}:${i + 1} ${r.api} — hard FAIL, the allowlist does not apply`
          );
      }
      for (const r of RULES) {
        if (r.re.test(line)) {
          if (allowlist[base]) allowlist[base].hits += 1;
          else findings.push(`${rel}:${i + 1} references ${r.api} — not on the allowlist`);
        }
      }
    });
  }

  for (const [file, entry] of Object.entries(allowlist)) {
    if (!files.some((f) => basename(f) === file))
      findings.push(
        `allowlisted file ${file} is MISSING — the safety code it is supposed to hold is gone`
      );
    else if (entry.hits === 0)
      findings.push(
        `allowlisted file ${file} has ZERO network/process references — its safety code was gutted`
      );
  }

  return {
    name: "static-scan",
    title: "static source scan (network/process APIs)",
    pass: findings.length === 0,
    findings,
    allowlist,
    limits: [
      "This proves the absence of network code in THIS source tree — not in whatever npx actually downloaded. PROVE-IT.md §5 has the tarball-vs-repo recipe.",
      "Regex-level, not a parser: deliberately obfuscated code (string-built specifiers, bracket access) can evade it. That is exactly why the real control is OS confinement, not this scan.",
      "Blind to filesystem egress: a write into a cloud-synced folder leaves the machine with no socket and no line this scan could flag (PROVE-IT.md §6).",
    ],
  };
}

// ---- check 2: audit chain ---------------------------------------------------
export function auditCheck(dir = AUDIT_DIR) {
  const findings = [];
  const notes = [];
  const chain = verifyAuditChain(dir);
  if (chain.runs === 0) {
    notes.push(
      "no audit logs found (never run, or the dir was removed) — the chain is trivially intact; note that deleting the whole dir is itself undetectable (see limits)"
    );
  } else {
    notes.push(`${chain.runs} run log(s), chain order by filename`);
  }
  for (const b of chain.breaks)
    findings.push(`chain break at ${b.file}: ${b.reason}`);
  if (chain.total_tripwire_hits > 0)
    findings.push(
      `${chain.total_tripwire_hits} tripwire hit(s) recorded across all runs — an in-process network API was actually reached; read the logs`
    );
  return {
    name: "audit-chain",
    title: "audit log chain + tripwire hits",
    pass: chain.ok && chain.total_tripwire_hits === 0,
    findings,
    notes,
    limits: [...AUDIT_LIMITS],
  };
}

// ---- check 3: output scrub --------------------------------------------------
const SCRUB_SUBDIRS = ["reports", "snapshots", "audit"];
const SCRUB_EXTS = [".json", ".svg", ".html"];
const TRANSCRIPT_MIN_LEN = 400;
const TRANSCRIPT_MIN_SPACES = 40;

function* scrubFiles(root) {
  for (const sub of SCRUB_SUBDIRS) {
    const dir = join(root, sub);
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // subdir absent — nothing to scrub
    }
    const stack = entries.map((e) => ({ dir, e }));
    while (stack.length) {
      const { dir: d, e } = stack.pop();
      const p = join(d, e.name);
      if (e.isDirectory()) {
        try {
          for (const c of readdirSync(p, { withFileTypes: true }))
            stack.push({ dir: p, e: c });
        } catch {}
      } else if (SCRUB_EXTS.some((x) => e.name.endsWith(x))) {
        yield p;
      }
    }
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineOfIndex(text, idx) {
  return text.slice(0, idx).split("\n").length;
}

// Walk every string value in a JSON tree; strings that themselves parse as
// JSON are recursed into (nested-JSON smuggling).
function walkStrings(node, path, cb, depth = 0) {
  if (depth > 12) return;
  if (typeof node === "string") {
    cb(node, path);
    const t = node.trim();
    if (t.length > 1 && (t[0] === "{" || t[0] === "[")) {
      try {
        walkStrings(JSON.parse(t), `${path}(nested)`, cb, depth + 1);
      } catch {}
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkStrings(v, `${path}[${i}]`, cb, depth + 1));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      cb(k, `${path}.${k} (key)`);
      walkStrings(v, `${path}.${k}`, cb, depth + 1);
    }
  }
}

export function outputScrub(dataDir = join(homedir(), ".starforge"), opts = {}) {
  const home = opts.home ?? homedir();
  let user = opts.user;
  if (user === undefined) {
    try {
      user = userInfo().username;
    } catch {
      user = process.env.USER ?? "";
    }
  }
  const userRe =
    user && user.length >= 4 ? new RegExp(`\\b${escapeRe(user)}\\b`) : null;

  const findings = [];
  const notes = [];
  let scanned = 0;

  for (const file of scrubFiles(dataDir)) {
    scanned += 1;
    const rel = relative(dataDir, file);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      findings.push(`${rel}: unreadable (${e.message})`);
      continue;
    }

    // (a) real home dir / username appearing literally — masking failed.
    if (home && text.includes(home))
      findings.push(
        `${rel}:${lineOfIndex(text, text.indexOf(home))} contains the literal home directory path — maskPath failed for this file`
      );
    else if (userRe) {
      const m = userRe.exec(text);
      if (m)
        findings.push(
          `${rel}:${lineOfIndex(text, m.index)} contains the literal username — masking failed for this file`
        );
    }

    // (b) secret-shaped content — anything redact.mjs would have caught.
    let secretLines = 0;
    text.split("\n").forEach((line, i) => {
      if (redactSecrets(line) !== line) {
        findings.push(`${rel}:${i + 1} secret-shaped content (matches a redact.mjs pattern) survived into an output file`);
        secretLines += 1;
      }
    });
    if (secretLines === 0 && redactSecrets(text) !== text)
      findings.push(
        `${rel}: multi-line secret-shaped content (matches a redact.mjs pattern) survived into an output file`
      );

    // (c) transcript-leak heuristic — JSON string values only.
    if (file.endsWith(".json")) {
      try {
        walkStrings(JSON.parse(text), "$", (s, where) => {
          if (s.length > TRANSCRIPT_MIN_LEN) {
            const spaces = (s.match(/ /g) ?? []).length;
            if (spaces > TRANSCRIPT_MIN_SPACES)
              findings.push(
                `${rel} ${where}: ${s.length}-char prose-like string (${spaces} spaces) — possible transcript text; starforge must never store conversation content`
              );
          }
        });
      } catch {
        findings.push(`${rel}: not valid JSON — cannot rule out embedded transcript text`);
      }
    }
  }

  notes.push(
    scanned === 0
      ? `nothing to scrub under ${maskPath(dataDir)} (no reports/snapshots/audit files yet)`
      : `scanned ${scanned} file(s) under ${maskPath(dataDir)} (${SCRUB_SUBDIRS.join(", ")}; ${SCRUB_EXTS.join(" ")})`
  );

  return {
    name: "output-scrub",
    title: "output files leak scan (~/.starforge)",
    pass: findings.length === 0,
    findings,
    notes,
    limits: [
      "Pattern checks on the files as they exist NOW: an unknown secret format or a deliberate encoding can slip past, and files already deleted or already synced away are out of reach.",
      "Covers this data dir only — a --join-fleet directory you pointed somewhere else is not scanned.",
      "The transcript heuristic (long, space-heavy strings) is a heuristic; code-like or short leaked text can pass it.",
    ],
  };
}

// ---- check 4: confinement availability --------------------------------------
function newestAuditConfinement(auditDir) {
  try {
    const files = readdirSync(auditDir)
      .filter((f) => /^run-.*\.json$/.test(f))
      .sort();
    if (!files.length) return null;
    const log = JSON.parse(readFileSync(join(auditDir, files[files.length - 1]), "utf8"));
    return log?.confinement ?? null;
  } catch {
    return null;
  }
}

export function confinementCheck({ auditDir = AUDIT_DIR } = {}) {
  const findings = [];
  const notes = [];
  const det = detectConfinement();

  notes.push(
    `platform ${det.platform}; OS confinement available: ${det.available.length ? det.available.join(", ") : "NONE"}`
  );
  if (det.recommended) {
    let proof = null;
    try {
      proof = buildProofCommand({ argv: ["--yes"] });
    } catch (e) {
      findings.push(`could not build the proof command: ${e.message}`);
    }
    if (proof) {
      notes.push("the real proof — run this yourself; the kernel, not this process, enforces it:");
      notes.push(`  ${maskPath(proof)}`);
      const probe =
        det.recommended === "sandbox-exec"
          ? `sandbox-exec -p '(version 1)(allow default)(deny network*)' ${process.execPath} ${join(SRC_DIR, "confine.mjs")} --probe`
          : `unshare -rn -- ${process.execPath} ${join(SRC_DIR, "confine.mjs")} --probe`;
      notes.push("positive control (tries to leave; the kernel must refuse):");
      notes.push(`  ${maskPath(probe)}`);
    }
  } else {
    findings.push(
      "no OS-level confinement mechanism found on this machine — there is no way to PROVE no-egress here, only policy"
    );
  }
  for (const n of det.notes ?? []) notes.push(n);

  const last = newestAuditConfinement(auditDir);
  if (last) {
    notes.push(
      `last recorded run: confinement mode "${last.mode}", verified: ${last.verified === true} — ${last.detail ?? ""}`
    );
  } else {
    notes.push("no audit log yet — nothing can be said about past runs");
  }

  return {
    name: "confinement",
    title: "OS confinement availability",
    pass: findings.length === 0,
    findings,
    notes,
    limits: [
      "This check reports what is AVAILABLE, not that any past run was confined. The audit log's confinement field is the process repeating a claim it cannot verify from inside.",
      "Only the printed command is proof, because YOU run it and the kernel does the refusing — a wrapper this tool applied to itself could be skipped or faked.",
      "Confinement seals sockets, not files: output written into a cloud-synced folder still leaves the machine (PROVE-IT.md §6).",
    ],
  };
}

// ---- runner -----------------------------------------------------------------
export function runVerify(opts = {}) {
  const dataDir = opts.dataDir ?? join(homedir(), ".starforge");
  const auditDir = opts.auditDir ?? join(dataDir, "audit");
  const checks = [
    staticScan(opts.srcDir ?? SRC_DIR),
    auditCheck(auditDir),
    outputScrub(dataDir, { home: opts.home, user: opts.user }),
    confinementCheck({ auditDir }),
  ];
  return { ok: checks.every((c) => c.pass), checks };
}

export function printVerify({ ok, checks }) {
  console.log(
    `${BOLD}${CYAN}starforge verify${RESET} ${DIM}— check the tool instead of trusting it. Each check prints its own limits: read them.${RESET}\n`
  );
  for (const c of checks) {
    const badge = c.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`${BOLD}${c.title}${RESET}  ${badge}`);
    for (const n of c.notes ?? []) console.log(`  ${n}`);
    for (const f of c.findings) console.log(`  ${RED}x${RESET} ${maskPath(f)}`);
    if (c.allowlist) {
      for (const [file, a] of Object.entries(c.allowlist))
        console.log(`  ${DIM}allowlisted: ${file} (${a.hits} hit${a.hits === 1 ? "" : "s"}) — ${a.reason}${RESET}`);
    }
    console.log(`  ${DIM}limits:${RESET}`);
    for (const l of c.limits) console.log(`    ${DIM}- ${l}${RESET}`);
    console.log("");
  }
  console.log(
    ok
      ? `${GREEN}${BOLD}verify: all checks passed${RESET} ${DIM}(within the limits printed above)${RESET}`
      : `${RED}${BOLD}verify: CHECKS FAILED${RESET}`
  );
  console.log(
    `${DIM}exit codes: 0 = every check passed · 1 = at least one FAIL · 2 = verify itself crashed${RESET}`
  );
  return ok;
}

// ---- CLI entry: `node src/verify.mjs` ---------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = runVerify({});
    printVerify(results);
    process.exit(results.ok ? 0 : 1);
  } catch (e) {
    console.error(`verify crashed: ${e?.stack ?? e}`);
    process.exit(2);
  }
}

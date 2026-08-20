// @ts-nocheck
// tests/offline-inference.test.mjs — "zero network calls at inference", tested
// as BEHAVIOUR instead of as a string.
//
// WHY THIS FILE EXISTS
//
// verify.mjs allowlists src/search.mjs on the strength of a marker
// (`{ label: "HF_HUB_OFFLINE comment (offline-at-inference guarantee)" }`) that
// searches search.mjs for the text "HF_HUB_OFFLINE". That marker reads a
// COMMENT in a JS file. The guarantee it stands for is a single assignment in
// a DIFFERENT file — src/search.py — which the static scan never opens:
//
//     os.environ["HF_HUB_OFFLINE"] = "1"   # never hit the network at inference
//
// So the check and the thing checked are not even in the same language. Rename
// the variable (`HF_HUB_OFFLINE_ENABLED`), set it and pop it again, or delete
// the line outright, and the marker still matches while models resolve over
// the network on every query. The last test in this file DEMONSTRATES that:
// it sabotages search.py, runs the real staticScan over the sabotaged tree,
// and shows it reporting a clean bill of health.
//
// The string check is still there and still worth having — it catches the
// whole comment being deleted. It is just not evidence about behaviour, so
// this file adds evidence about behaviour beside it.
//
// HOW THE DENIAL IS APPLIED
//
// From OUTSIDE the process under test, by the kernel, exactly as
// bin/starreckon-proof.sh does it — and judged the same way: the identical
// probe must CONNECT outside the wall and be REFUSED inside it, or the run is
// INCONCLUSIVE rather than a pass. The probe is the repo's own
// `node src/confine.mjs --probe` (exit 0 = kernel refused, 1 = egress open,
// 2 = ambiguous); no second probe was invented for this file.
//
// The wall is whichever one this machine actually has, asked for in
// src/confine.mjs's own order: detectConfinement().recommended first
// (sandbox-exec on macOS, `unshare -rn` on a permissive Linux kernel), and
// `docker run --network none` only when that comes back empty — which is what
// confine.mjs's own note tells the user to do when unshare is refused.
//
// On the machine this was written on, only the last one works: sandbox-exec is
// macOS-only, `unshare -rn` and `bwrap --unshare-net` are refused under
// apparmor_restrict_unprivileged_userns=1 (Ubuntu 23.10+, the default), and
// `systemd-run --user -p PrivateNetwork=yes` is worse than refused — it exits
// 0 and does NOT apply, so the probe inside it connects. That last case is why
// every wall here is probed before it is trusted, whichever one was chosen.
//
// WHAT STANDS IN FOR THE MODELS
//
// The real run needs ~600 MB of SecureBERT under ~/.starreckon/.venv-search,
// downloaded by `starreckon search --setup`. When that venv is present the
// last-but-one test runs it unstubbed under the same wall. When it is absent
// (the usual case, and the case on the machine this was written on) that test
// SKIPS LOUDLY, and the tests below run the real src/search.py against a stub
// `sentence_transformers` that mimics the one behaviour under test: it reads
// HF_HUB_OFFLINE at import time the way huggingface_hub does, and when it is
// not set it opens a real socket before returning a model. So the code under
// test is starreckon's, the decision under test is starreckon's, and only the
// tensors are fake.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { staticScan } from "../src/verify.mjs";
import { detectConfinement, sandboxProfile } from "../src/confine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_PY = join(ROOT, "src", "search.py");
const CONFINE = join(ROOT, "src", "confine.mjs");

// Images are looked up locally and never pulled: a test that downloads is a
// test that fails on the machine that most needs it (the sealed one).
const PY_IMAGE = "python:3.12-slim";
const NODE_IMAGE = "node:22-slim";

// The one host anything in this repo is allowed to name (verify.mjs's
// ALLOWED_EGRESS_LITERALS): confine.mjs's positive-control probe. The stub
// dials the same one instead of a second destination.
const PROBE_HOST = "1.1.1.1";
const PROBE_PORT = 443;

// The line in search.py that IS the guarantee, and the rename that keeps the
// static marker matching while breaking it. `_ENABLED` is deliberate: the
// string "HF_HUB_OFFLINE" survives it, so verify.mjs cannot tell.
const GUARANTEE_LINE = 'os.environ["HF_HUB_OFFLINE"] = "1"';
const SABOTAGED_LINE = 'os.environ["HF_HUB_OFFLINE_ENABLED"] = "1"';

// ---------------------------------------------------------------------------
// fixtures

// Stands in for sentence_transformers + huggingface_hub. Fidelity, stated
// plainly: the real library reads HF_HUB_OFFLINE into a module constant AT
// IMPORT TIME and, when it is unset, resolves the repo id over the network
// before a single weight is read. This does that and nothing else. It is a
// stand-in for the download path, not for the maths.
const STUB_ST = `import json, os, pathlib, socket

RECORD = pathlib.Path(os.environ["STARRECKON_STUB_RECORD"])
HUB_HOST, HUB_PORT = "${PROBE_HOST}", ${PROBE_PORT}

# Read at import time, exactly like huggingface_hub.constants — which is why
# search.py must set it BEFORE the import, and why a set-then-unset is caught.
OFFLINE_AT_IMPORT = os.environ.get("HF_HUB_OFFLINE")


def _record(**kw):
    with RECORD.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(kw) + "\\n")


_record(event="import", hf_hub_offline=OFFLINE_AT_IMPORT, hf_home=os.environ.get("HF_HOME"))


def _resolve(repo_id):
    _record(event="resolve", repo=repo_id, hf_hub_offline=OFFLINE_AT_IMPORT)
    if OFFLINE_AT_IMPORT == "1":
        _record(event="local-cache", repo=repo_id)
        return "local-cache"
    _record(event="connect-attempt", repo=repo_id, host=HUB_HOST, port=HUB_PORT)
    try:
        sock = socket.create_connection((HUB_HOST, HUB_PORT), timeout=5)
    except OSError as e:
        _record(event="connect-refused", repo=repo_id, errno=e.errno, err=str(e))
        raise
    sock.close()
    _record(event="connected", repo=repo_id, host=HUB_HOST, port=HUB_PORT)
    return "network"


class SentenceTransformer:
    def __init__(self, repo_id, **kw):
        self.repo_id, self.source = repo_id, _resolve(repo_id)

    def encode(self, docs, **kw):
        if isinstance(docs, str):
            docs = [docs]
        _record(event="encode", n=len(docs))
        return [[float(len(d) % 7)] * 8 for d in docs]


class CrossEncoder:
    def __init__(self, repo_id, **kw):
        self.repo_id, self.source = repo_id, _resolve(repo_id)

    def predict(self, pairs, **kw):
        _record(event="predict", n=len(pairs))
        return [float(len(q) - len(d)) for q, d in pairs]
`;

// Loads the search.py handed to it and runs the two inference calls search.py
// itself makes. It decides nothing about the network: that decision lives
// entirely in the file under test.
const DRIVER = `import importlib.util, json, sys

target = sys.argv[1]
spec = importlib.util.spec_from_file_location("search_under_test", target)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

bi, cross = mod._load_models()          # the only place inference can reach the network
vecs = bi.encode(["hello world"], convert_to_numpy=True)
scores = cross.predict([("query", "document")])
print("INFERENCE-OK " + json.dumps({"dims": len(vecs[0]), "scores": list(scores)}))
`;

// ---------------------------------------------------------------------------
// the fixture tree: two copies of the real search.py (armed and sabotaged),
// a fake venv laid out where search.py looks for one, and the stub inside it.

const T = mkdtempSync(join(tmpdir(), "sr-offline-"));
after(() => rmSync(T, { recursive: true, force: true }));

const realSearchPy = readFileSync(SEARCH_PY, "utf8");
assert.ok(
  realSearchPy.includes(GUARANTEE_LINE),
  `src/search.py no longer contains ${GUARANTEE_LINE} — this test's sabotage target moved, ` +
    `and a sabotage that does not apply would make every test below pass for the wrong reason`
);
const sabotagedSearchPy = realSearchPy.replace(GUARANTEE_LINE, SABOTAGED_LINE);
assert.ok(sabotagedSearchPy.includes("HF_HUB_OFFLINE"), "the sabotage must keep the marker string intact");
assert.ok(!sabotagedSearchPy.includes(GUARANTEE_LINE), "the sabotage must actually remove the assignment");

mkdirSync(join(T, "armed"));
mkdirSync(join(T, "sabotaged"));
writeFileSync(join(T, "armed", "search.py"), realSearchPy);
writeFileSync(join(T, "sabotaged", "search.py"), sabotagedSearchPy);
writeFileSync(join(T, "drive.py"), DRIVER);

const FAKE_VENV = join(T, "home", ".starreckon", ".venv-search");
mkdirSync(join(FAKE_VENV, "bin"), { recursive: true });
writeFileSync(join(FAKE_VENV, "bin", "python"), "#!/bin/sh\nexec python3 \"$@\"\n");
const SITE = join(FAKE_VENV, "lib", "python3.12", "site-packages", "sentence_transformers");
mkdirSync(SITE, { recursive: true });
writeFileSync(join(SITE, "__init__.py"), STUB_ST);

// ---------------------------------------------------------------------------
// running things, inside the wall and outside it

function docker(args, timeout = 180000) {
  return spawnSync("docker", args, { encoding: "utf8", timeout });
}

function dockerStatus() {
  const v = docker(["version", "--format", "{{.Server.Version}}"], 20000);
  if (v.error || v.status !== 0) return { ok: false, reason: "no reachable docker daemon" };
  for (const img of [PY_IMAGE, NODE_IMAGE]) {
    const i = docker(["image", "inspect", img], 20000);
    if (i.status !== 0) return { ok: false, reason: `image ${img} is not present locally (this test never pulls)` };
  }
  return { ok: true, reason: "" };
}

// Environment for a run under test. HF_HUB_OFFLINE is DELETED, never set: the
// only thing allowed to put it there is src/search.py itself. Handing it in
// from the caller would make the test pass with search.py:87 deleted — the very
// mutation this file exists to catch.
function childEnv(record) {
  const env = { ...process.env, HOME: join(T, "home"), STARRECKON_STUB_RECORD: join(T, record) };
  delete env.HF_HUB_OFFLINE;
  delete env.HF_HOME;
  return env;
}

// Pick the wall the way src/confine.mjs would, and fall back to a container
// only when it says there is nothing on this machine. Every wall returns the
// same shape: wrap(argv) -> argv to spawn, and the paths the child will see.
function pickWall() {
  const det = detectConfinement();
  const python = spawnSync("python3", ["-V"], { encoding: "utf8" });
  const hostWall = (kind, wrap) =>
    python.status === 0
      ? { ok: true, kind, wrap, node: process.execPath, python: "python3", t: T, repo: ROOT, env: childEnv }
      : { ok: false, reason: `${kind} is available but python3 is not runnable here` };

  if (det.recommended === "sandbox-exec")
    return hostWall("sandbox-exec", (argv) => ["/usr/bin/sandbox-exec", "-p", sandboxProfile(), ...argv]);
  if (det.recommended === "netns") return hostWall("netns", (argv) => ["unshare", "-rn", ...argv]);

  const d = dockerStatus();
  if (!d.ok) return { ok: false, reason: `${det.notes.at(-1)} — and no container fallback: ${d.reason}` };
  // --network none gives the container no interfaces and no routes, so connect()
  // fails in the kernel before a packet exists. --user keeps whatever the
  // container writes into the bind mount owned by the test, not by root.
  return {
    ok: true,
    kind: "docker",
    node: "node",
    python: "python3",
    t: "/t",
    repo: "/repo",
    image: (argv) => (argv[0] === "node" ? NODE_IMAGE : PY_IMAGE),
    wrap(argv, record) {
      return [
        "docker", "run", "--rm",
        "--network", "none",
        "--user", `${process.getuid()}:${process.getgid()}`,
        "-v", `${T}:/t`,
        "-v", `${ROOT}:/repo:ro`,
        "-e", "HOME=/t/home",
        "-e", `STARRECKON_STUB_RECORD=/t/${record}`,
        this.image(argv),
        ...argv,
      ];
    },
    env: () => process.env,
  };
}

const WALL = pickWall();

// Run argv inside the wall (or on the host when `confined` is false). Both
// sides get the same argv and the same environment; only the wall differs,
// which is what makes the two results comparable.
function run({ argv, confined, record, timeout = 180000 }) {
  const full = confined && WALL.kind === "docker" ? WALL.wrap(argv, record) : confined ? WALL.wrap(argv) : argv;
  const env = confined && WALL.kind === "docker" ? WALL.env() : childEnv(record);
  return spawnSync(full[0], full.slice(1), { encoding: "utf8", timeout, env });
}

// One inference run: real src/search.py (armed or sabotaged) + the stub loader.
function runInference({ variant, confined, record }) {
  rmSync(join(T, record), { force: true });
  const base = confined ? { t: WALL.t, py: WALL.python } : { t: T, py: "python3" };
  const r = run({
    argv: [base.py, `${base.t}/drive.py`, `${base.t}/${variant}/search.py`],
    confined,
    record,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? ` [spawn: ${r.error.message}]` : ""}`;
  const lines = existsSync(join(T, record))
    ? readFileSync(join(T, record), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { status: r.status, out, events: lines };
}

// The outside control, run exactly once: the repo's own probe on the host. If
// this machine cannot reach the network at all, a refusal inside the wall
// proves nothing — the same reasoning bin/starreckon-proof.sh prints as
// INCONCLUSIVE rather than PASS.
const outsideProbe = spawnSync(process.execPath, [CONFINE, "--probe"], { encoding: "utf8", timeout: 20000 });
const EGRESS_OPEN = outsideProbe.status === 1;

// A skip nobody notices is a pass in disguise. Say it on stderr as well as in
// the TAP stream, and say what was NOT verified rather than what was skipped.
function loudSkip(t, reason) {
  console.error(`\n!!  NOT VERIFIED: offline-at-inference behaviour — ${reason}\n`);
  t.skip(reason);
}

function needWall(t) {
  if (!WALL.ok) return loudSkip(t, `no usable network wall here: ${WALL.reason}`), false;
  if (!EGRESS_OPEN)
    return (
      loudSkip(
        t,
        "the outside control did not connect (machine offline?) — a refusal inside the wall " +
          "cannot be told apart from having no network at all"
      ),
      false
    );
  return true;
}

// ---------------------------------------------------------------------------
// controls first: is there a wall, and is it really a wall?

test("control: the identical probe CONNECTS outside the wall", (t) => {
  if (!WALL.ok) return void loudSkip(t, `no usable network wall here: ${WALL.reason}`);
  if (!EGRESS_OPEN) return void loudSkip(t, "this machine has no egress — nothing below can be conclusive");
  assert.match(outsideProbe.stdout, /egress attempt: TCP 1\.1\.1\.1:443/);
  assert.match(outsideProbe.stdout, /NOT BLOCKED/);
});

test("control: the kernel REFUSES the same probe inside the wall", (t) => {
  if (!needWall(t)) return;
  // src/confine.mjs --probe, unchanged, run under whichever wall was chosen.
  // Same probe, same exit codes, same reading as bin/starreckon-proof.sh 3/3.
  const r = run({
    argv: [WALL.node, `${WALL.repo}/src/confine.mjs`, "--probe"],
    confined: true,
    record: "probe.jsonl",
    timeout: 60000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, `expected BLOCKED (exit 0), got exit ${r.status}:\n${out}`);
  assert.match(out, /BLOCKED/);
  assert.match(out, /kernel refused before any packet could leave/);
});

// ---------------------------------------------------------------------------
// the guarantee

test("ARMED: inference completes with the network denied, and the loader saw HF_HUB_OFFLINE=1", (t) => {
  if (!needWall(t)) return;
  // STARRECKON_OFFLINE_SABOTAGE=1 points this case at the sabotaged copy so the
  // failure can be seen on demand. It can only turn this pass into a failure,
  // never the reverse — a test whose failure has never been witnessed is not
  // known to be able to fail.
  const variant = process.env.STARRECKON_OFFLINE_SABOTAGE === "1" ? "sabotaged" : "armed";
  const r = runInference({ variant, confined: true, record: "armed.jsonl" });

  assert.equal(r.status, 0, `inference did not survive the sealed network:\n${r.out}`);
  assert.match(r.out, /INFERENCE-OK/, r.out);

  const resolves = r.events.filter((e) => e.event === "resolve");
  assert.equal(resolves.length, 2, `both models must be loaded, got ${resolves.length}: ${r.out}`);
  for (const e of resolves) {
    assert.equal(
      e.hf_hub_offline,
      "1",
      `the model loader read HF_HUB_OFFLINE=${JSON.stringify(e.hf_hub_offline)} for ${e.repo} — ` +
        `the offline guarantee was not in force at the moment it mattered`
    );
  }
  // The claim is zero network calls, so the evidence has to be zero attempts —
  // not "the attempts failed".
  assert.deepEqual(
    r.events.filter((e) => e.event === "connect-attempt" || e.event === "connected"),
    [],
    `inference reached for the network: ${JSON.stringify(r.events)}`
  );
  assert.equal(r.events.filter((e) => e.event === "local-cache").length, 2);
  // and it really did run, rather than exiting 0 before touching a model
  assert.ok(r.events.some((e) => e.event === "encode"));
  assert.ok(r.events.some((e) => e.event === "predict"));
});

// ---------------------------------------------------------------------------
// positive controls: without the guarantee, this code DOES go to the network.
// Without these two, "inference made no network call" is indistinguishable
// from "no inference ran".

test("POSITIVE CONTROL: with the flag renamed, inference reaches the network for real (outside the wall)", (t) => {
  if (!WALL.ok && !EGRESS_OPEN) return void loudSkip(t, "no egress and no wall — nothing to compare");
  if (!EGRESS_OPEN) return void loudSkip(t, "no egress on this machine — cannot show the call succeeding");
  const r = runInference({ variant: "sabotaged", confined: false, record: "sabotage-open.jsonl" });
  const connected = r.events.filter((e) => e.event === "connected");
  assert.equal(
    connected.length,
    2,
    `the sabotaged loader was supposed to dial out and did not — then its failure inside ` +
      `the wall would prove nothing:\n${r.out}\n${JSON.stringify(r.events)}`
  );
  assert.equal(connected[0].host, PROBE_HOST);
  assert.equal(r.status, 0, r.out);
  // and it was the rename that did it — the loader saw no offline flag at all
  assert.equal(r.events.find((e) => e.event === "import").hf_hub_offline, null);
});

test("POSITIVE CONTROL: the same sabotaged inference is REFUSED inside the wall", (t) => {
  if (!needWall(t)) return;
  const r = runInference({ variant: "sabotaged", confined: true, record: "sabotage-walled.jsonl" });
  assert.notEqual(r.status, 0, `sabotaged inference should not have survived the wall:\n${r.out}`);
  // search.py catches the load failure and prints it — the text is the receipt
  assert.match(r.out, /Could not load models/, r.out);
  assert.match(r.out, /unreachable|refused|denied|Temporary failure/i, r.out);
  const refused = r.events.filter((e) => e.event === "connect-refused");
  assert.ok(refused.length >= 1, `expected a kernel refusal, got: ${JSON.stringify(r.events)}`);
  assert.equal(refused[0].errno, 101, `ENETUNREACH(101) expected, got ${JSON.stringify(refused[0])}`);
  assert.equal(r.events.filter((e) => e.event === "connected").length, 0);
});

// ---------------------------------------------------------------------------
// the unstubbed run, when the models are actually here

test("real SecureBERT models: an unstubbed query under the wall", (t) => {
  const venvPy = join(homedir(), ".starreckon", ".venv-search", "bin", "python");
  const index = join(homedir(), ".starreckon", "search-index", "index.faiss");
  if (!existsSync(venvPy) || !existsSync(index)) {
    // The stubbed tests above still ran; what is missing here is the real
    // sentence-transformers, and only that.
    return void loudSkip(
      t,
      `the real models are not installed (${existsSync(venvPy) ? "index" : "venv"} missing under ~/.starreckon) — ` +
        `run \`starreckon search --setup\` and \`--index\` to make this test run for real; ` +
        `the stubbed loader tests above covered starreckon's own code but not sentence-transformers'`
    );
  }
  if (!needWall(t)) return;
  const home = homedir();
  const query = [venvPy, SEARCH_PY, "query", "authentication"];
  // A host wall (sandbox-exec, netns) runs the user's own venv in place. The
  // container fallback has to mount the real HOME at its real path so the
  // venv's absolute paths still resolve — read-only, because this test must not
  // be able to modify anything of the user's.
  const argv =
    WALL.kind === "docker"
      ? ["docker", "run", "--rm", "--network", "none",
         "--user", `${process.getuid()}:${process.getgid()}`,
         "-v", `${home}:${home}:ro`,
         "-e", `HOME=${home}`,
         PY_IMAGE, ...query]
      : WALL.wrap(query);
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 300000, env: { ...process.env } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status === 0) {
    assert.match(out, /query:/, out);
    return;
  }
  // A non-zero exit is only a verdict when it is a NETWORK verdict. Anything
  // else (a venv that will not run under this image, an incomplete cache) is
  // inconclusive and is reported as such rather than rounded to a failure —
  // the same distinction bin/starreckon-proof.sh draws for its scan step. Note
  // which side of the line huggingface's own offline error falls on: "offline
  // mode is enabled" is the guarantee HOLDING against a thin cache, not
  // breaking, so it must not be read as a failure here.
  if (
    /ENETUNREACH|Network is unreachable|Max retries|Failed to establish|getaddrinfo|Temporary failure|HTTPSConnectionPool|ConnectionError/i.test(
      out
    )
  ) {
    assert.fail(`inference tried to reach the network with the models installed:\n${out}`);
  }
  loudSkip(t, `the real-model run could not start under the wall for a non-network reason:\n${out}`);
});

// ---------------------------------------------------------------------------
// and the reason all of the above had to be written

test("the static marker still passes on a tree whose offline guarantee has been removed", () => {
  // Not a criticism of the marker — a measurement of what it covers. The
  // sabotage is the one an attacker would pick precisely because it survives
  // the scan: the string stays, the assignment goes.
  const dir = mkdtempSync(join(tmpdir(), "sr-offline-scan-"));
  try {
    cpSync(ROOT, dir, {
      recursive: true,
      filter: (src) => !src.includes(`${ROOT}/.git`) && !src.includes("node_modules"),
    });
    writeFileSync(join(dir, "src", "search.py"), sabotagedSearchPy);
    const res = staticScan(dir);
    assert.deepEqual(
      res.findings,
      [],
      `staticScan was expected to be blind to this, and is not — good news, ` +
        `but this test's premise needs rewriting: ${JSON.stringify(res.findings)}`
    );
    assert.equal(res.allowlist["search.mjs"].found, true);
    assert.ok(
      res.allowlist["search.mjs"].hits > 0,
      "the HF_HUB_OFFLINE marker still matched — the comment is intact, the behaviour is not"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

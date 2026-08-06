# PROVE IT

starforge's pitch is "nothing leaves your machine." You should not take that on
faith — not from this README, not from a grep, and not from any check the tool
runs on itself. This page lists every way to verify the claim, strongest first,
and states plainly what each method does **not** prove.

One principle runs through all of it: **a check the tool applies to itself can
be faked by the tool; a check YOU run cannot.** Everything below is a command
you run.

---

## 1. The strongest proof: OS confinement (the kernel refuses the network)

Anything running *inside* a process — monkey-patches, wrappers, audit hooks —
can be bypassed from inside that process: worker threads get a fresh realm,
spawned children get a fresh runtime, low-level bindings sit below the patched
JS layer. The kernel sits below all of them. Run starforge inside an OS
sandbox that denies network syscalls and the question is closed for the whole
process tree, no trust in starforge required.

### macOS (`sandbox-exec`)

```
cd starforge   # a git clone of the source tree you have read
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)(deny network-outbound)(deny network-inbound)' node src/cli.mjs --yes
```

The scan runs normally — it needs only file reads and writes — and any network
attempt by this process *or anything it spawns* dies at the syscall.

**Positive control** — a proof that never tries to cross the wall proves
nothing about the wall. `node src/confine.mjs --probe` deliberately attempts
one outbound TCP connect (1.1.1.1:443). Run it both ways:

```
# outside the sandbox — shows the probe is a real network attempt:
node src/confine.mjs --probe
# result: NOT BLOCKED — connected to 1.1.1.1:443 — egress is OPEN in this context

# inside the sandbox — shows the kernel refusing that same attempt:
sandbox-exec -p '(version 1)(allow default)(deny network*)' node src/confine.mjs --probe
# result: BLOCKED — EPERM on connect() — the kernel refused before any packet could leave
```

Both outputs above are verbatim from a run on this machine (macOS 15, Node 20).
`sandbox-exec` is marked deprecated in Apple's man page but still enforces —
and you don't have to take that on faith either: that is exactly what the
positive control demonstrates, live, on your machine.

### Linux (network namespace)

```
unshare -rn -- node src/cli.mjs --yes          # fresh netns: no interfaces, no routes
unshare -rn -- node src/confine.mjs --probe    # expect BLOCKED — ENETUNREACH
```

A timeout is **not** counted as blocked by the probe — dropped packets may
still have left the machine — only a definite kernel refusal (EPERM, EACCES,
ENETUNREACH, ENETDOWN) is.

`node src/confine.mjs` (no flags) prints what is available on your machine and
the exact proof command for it.

---

## 2. `starforge verify` — what each check covers, and what it doesn't

```
node src/verify.mjs        # from a checkout
npx starforge verify       # once wired into the published CLI
```

Exit codes: `0` every check passed · `1` at least one FAIL · `2` verify itself
crashed. Every check prints its own limits under its result; they are the same
ones listed here.

| Check | Proves | Does NOT prove |
|---|---|---|
| **static-scan** | No reference to network/process APIs (net, http(s), dns, tls, dgram, child-process, worker-threads, fetch, WebSocket, XHR, eval, new Function, process-level bindings, non-literal dynamic imports) anywhere in the source tree except two allowlisted files — `src/tripwire.mjs` (imports network modules only to replace them with throwers) and `src/confine.mjs` (the sandbox launcher + the positive-control probe). An allowlisted file with **zero** hits also fails: that means its safety code was gutted. | What actually ran (see §5 — npx runs a tarball, not your grepped tree); obfuscated code built to evade a regex; filesystem egress (§6). |
| **audit-chain** | The hash-chained run logs are individually un-edited and record zero tripwire hits. | Anything against a wholesale rewrite of every log, or against a deleted audit dir, or against a compromised build that logs lies. Tamper-*evident*, not tamper-*proof*. |
| **output-scrub** | The files currently under `~/.starforge` contain no literal home dir/username, nothing matching the secret patterns in `src/redact.mjs`, and no transcript-sized prose strings (JSON string values >400 chars with >40 spaces, nested JSON included). | Files already synced away or deleted; encodings the patterns don't know; a `--join-fleet` dir outside `~/.starforge`. |
| **confinement** | Whether OS confinement is *available* on this machine, plus the exact proof command; reports the newest audit log's confinement claim as a claim. | That any past run was actually confined. Only §1, run by you, proves a run. |

The in-process tripwire that feeds the audit log is a **tripwire for accidental
egress, not a security boundary**. Red-teaming on this codebase's own design
demonstrated the bypasses: worker threads (fresh realm, patches absent),
spawned child processes (fresh runtime), `process.binding('tcp_wrap')` (below
the patched JS layer), and patch restoration. Those holes are why §1 exists and
why `verify` prints limits instead of promises.

---

## 3. Watch the process from outside while a scan runs

Independent of everything starforge says about itself:

```
node src/cli.mjs --yes & PID=$!

# every open socket of that pid, sampled until it exits (empty output = no sockets):
while kill -0 $PID 2>/dev/null; do lsof -i -a -p $PID; sleep 0.2; done

# per-process network bytes in/out, 5 samples (macOS):
nettop -P -p $PID -L 5
```

Caveats, honestly: `lsof` samples — a socket that opens and closes between
samples can be missed — and child processes have their own pids. The
whole-machine view has no such gap:

```
# in one terminal (whole machine — attribute other apps' traffic carefully):
sudo tcpdump -i any -n 'not (host 127.0.0.1 or host ::1)'
# in another: node src/cli.mjs --yes
```

For a per-process answer with no sampling gap, combine with §1: confinement
plus tcpdump showing nothing is as closed as this question gets.

---

## 4. The audit log

Every run writes `~/.starforge/audit/run-<timestamp>.json` (schema v1):
what was read (source → count), every file written (masked path + sha256 +
bytes), the sha256 of every source file that ran and a combined `source_hash`
(compare it to the tree you audited), any tripwire hits, argv (redacted), the
confinement mode claimed for the run, and `prev_log_sha256` — the hash of the
previous log, forming a chain. `starforge verify` re-walks the chain.

**The wholesale-rewrite limit, stated plainly:** the chain makes editing any
*individual* past log detectable. It does nothing against an attacker (or a
malicious build) that deletes or regenerates *every* log with a self-consistent
chain, and the newest log is unprotected until the next run chains onto it.
This is tamper-evident bookkeeping by the very process it describes — useful
for catching accidents and casual tampering, worthless as cryptographic
attestation. Treat it accordingly.

---

## 5. Supply chain: the tarball you run vs the tree you grepped

`npx starforge` executes a tarball from the npm registry. A grep of this repo
proves **this repo** — it proves nothing about that tarball unless you check
they match:

```
npm pack starforge@<version> --silent     # fetches the EXACT published artifact
shasum -a 256 starforge-<version>.tgz
npm view starforge@<version> dist.shasum dist.integrity   # registry's own hashes — must match your file

tar -xzf starforge-<version>.tgz          # unpacks into ./package
diff -r package/src <your-audited-checkout>/src
diff package/package.json <your-audited-checkout>/package.json
```

Any difference under `src/` means you are not running the code you read — stop
and read the diff. You can also point the warden at the unpacked tarball
itself: `node package/src/verify.mjs`. And §1 works on the tarball too, which
is the backstop when you don't want to diff at all: run the unpacked package
under confinement and the provenance question stops mattering for egress.

---

## 6. Filesystem egress — the blind spot every socket check has

A process needs no socket to leak data: **a file written into a cloud-synced
folder or a network mount leaves the machine later, carried by your sync
agent.** Neither the static scan, nor the tripwire, nor `tcpdump` on this
process, nor the §1 sandbox will ever flag that — the write is local and
legitimate as far as the kernel is concerned.

What starforge writes, exhaustively:

- `~/.starforge/` — reports, snapshots, audit logs. Nothing else, ever,
  unless you ask.
- `--join-fleet=DIR` — a directory **you** name. If you name a synced or
  network-mounted directory, its contents leave the machine **by design** —
  that flag exists precisely to share fleet stats across machines. The same
  applies if you sync `~/.starforge/snapshots` between machines, which the
  README suggests: that is deliberate egress under your control.

So the honest statement is: starforge's outputs stay local **until you place
them somewhere that syncs**. What makes that acceptable is what's *in* the
files — masked paths, redacted secrets, aggregates instead of transcripts —
and that is exactly what the `output-scrub` check inspects and what
`~/.starforge` holds in plain JSON/SVG/HTML for you to read yourself. Check
whether a destination is a mount before pointing `--join-fleet` at it:
`df -P <DIR> | tail -1`.

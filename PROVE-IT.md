# PROVE IT

starforge's pitch is "nothing leaves your machine." You should not take that on
faith — not from this README, not from a grep, and not from any check the tool
runs on itself. This page lists every way to verify the claim, strongest first,
and states plainly what each method does **not** prove.

One principle runs through all of it: **a check the tool applies to itself can
be faked by the tool; a check YOU run cannot.** Everything below is a command
you run.

**Names and status, up front, because two commands here depend on it:** the npm
package is **`starforge-cli`** (the bare name `starforge` belongs to an
unrelated 2017 package — `npx starforge` is not this tool). Both the package and
the repo are live: `npm view starforge-cli` and
`github.com/Alexander-Sorrell-IT/starforge`. Every `starforge-cli …` command
below still has a "run it from this checkout" form next to it
(`node src/cli.mjs …`), and **the checkout is the thing you can read before you
run it** — which is precisely why §5 exists: what `npx` executes is a registry
tarball, not the tree you grepped, and §5 is how you check the two match.

---

## 0. The one-command version

Everything in §1 and §2, scripted, with a verdict at the end:

```
sh bin/starforge-proof.sh          # macOS; plain POSIX shell, short enough to read first
```

It prints the sandbox profile, runs a full scan **inside** a deny-network
sandbox, then fires the positive-control probe **outside** the sandbox (must
connect — otherwise the control is invalid) and **inside** it (the kernel must
refuse). The verdict is `PASS` / `FAIL` / `INCONCLUSIVE`, and it judges the
**egress** question only: exit 0 means the outside probe connected and the
inside one was refused by the kernel. If the machine is offline it says
`INCONCLUSIVE` rather than claiming a pass — a refusal you cannot distinguish
from having no network proves nothing.

The scan's own exit code is printed as a separate line and named again under
the verdict, deliberately **not** folded into it: a machine with no AI-coding
logs to read still gets a real egress answer instead of a `FAIL` about
something the kernel proof never asked.

```
node src/cli.mjs prove             # or: starforge-cli prove
```

`prove` runs nothing. It prints what confinement is available on this machine,
the exact sandbox profile, the exact command to run, and the path to the script
above — so you can inspect the proof before you trust it.

The rest of this page is the same proofs, one at a time, with their limits.

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
cd <the checkout you have read>   # this repo's tree — see "Names and status" above
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)(deny network-outbound)(deny network-inbound)' node src/cli.mjs --yes
```

The scan runs normally — it needs only file reads and writes — and any network
attempt by this process *or anything it spawns* dies at the syscall.

**Positive control** — a proof that never tries to cross the wall proves
nothing about the wall. `node src/confine.mjs --probe` deliberately attempts
one outbound TCP connect (1.1.1.1:443). Run it both ways:

```
# outside the sandbox — shows the probe is a real network attempt:
$ node src/confine.mjs --probe
egress attempt: TCP 1.1.1.1:443 (timeout 3000ms)
result: NOT BLOCKED — connected to 1.1.1.1:443 — egress is OPEN in this context

# inside the sandbox — shows the kernel refusing that same attempt:
$ sandbox-exec -p '(version 1)(allow default)(deny network*)' node src/confine.mjs --probe
egress attempt: TCP 1.1.1.1:443 (timeout 3000ms)
result: BLOCKED — EPERM on connect() — the kernel refused before any packet could leave (connect EPERM 1.1.1.1:443 - Local (0.0.0.0:0))
```

Both blocks above are copied verbatim from a run on this machine (macOS 15,
Node 20) — including the errno detail in parentheses, which is the part that
makes it a kernel refusal rather than a story about one. The probe exits `0`
when blocked, `1` when egress is open, `2` when the result is ambiguous.
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

## 2. `starforge-cli verify` — what each check covers, and what it doesn't

```
node src/verify.mjs        # from a checkout
node src/cli.mjs verify    # same checks, through the CLI
starforge-cli verify       # the published package
```

Exit codes, printed by `verify` itself at the end of every run: `0` = nothing
FAILED · `1` = at least one check FAILED · `2` = **verify itself crashed** —
not a failed check and not a pass, but "the warden could not do its job, so the
result is unknown." Both entry points above go through the same function, so
the contract cannot differ between them. Read the printed output; don't infer
the reason from the number.

A check that had **nothing to inspect** — no audit logs yet, no output files
yet — prints `SKIP (nothing to inspect — NOT a pass)`, and the summary line counts
those separately from the ones that passed, so "all checks passed" is never
printed for checks that read nothing. `SKIP` does not fail the run, which is
why the exit code alone is never the answer. Every check prints its own limits under its result; they are the same
ones listed here.

| Check | Proves | Does NOT prove |
|---|---|---|
| **static-scan** | No reference to network/process APIs (net, http(s), dns, tls, dgram, child-process, worker-threads, fetch, WebSocket, XHR, eval, new Function, process-level bindings, non-literal dynamic imports) anywhere in the files this package **publishes** — JS, the shell script, and `package.json` alike — except two allowlisted files: `src/tripwire.mjs` (imports network modules only to replace them with throwers) and `src/confine.mjs` (the sandbox launcher + the positive-control probe, which really does connect). Those two are held to four extra rules: a SHA-256 content pin, the disarm code still being present (imports alone are not enough), no egress destination other than the probe's own hardcoded target, and **zero** hits failing too — zero means the safety code was gutted. The check prints its own file inventory, including which shipped files no rule set covers. | What actually ran (see §5 — npx runs a tarball, not your grepped tree); obfuscated code built to evade a regex; shipped **test** files, which are enumerated but deliberately not judged (a scanner's test suite must contain the strings it hunts); a whole modified package shipped with a regenerated pin manifest; filesystem egress (§6). |
| **audit-chain** | That the run logs still hash-chain together, that the oldest one is a genesis log, that `run_index` has no gaps and matches the counter kept outside the audit dir, and that zero tripwire hits are recorded (including hits from runs that aborted — those are flushed to disk at the moment of the hit). | Anything against an attacker who rewrites a whole *suffix* of the history **and** the counter file, or against a compromised build that logs lies. The `run_index` gap checks apply only to logs that carry one (schema 2); any pre-v2 logs still on disk are hash-chained and nothing more. Tamper-*evident*, not tamper-*proof* (§4). |
| **output-scrub** | That the files it read under `~/.starforge` contain no literal home dir/username, no email address, nothing matching the secret patterns in `src/redact.mjs`, and no transcript-sized prose strings (>400 chars with >40 spaces). The walk covers **every file under that directory, at any depth, whatever the extension** — and the note it prints names and counts the four kinds it declines to read (over 4 MB, binary by NUL sniff, symlinks, non-regular files), so "not scanned" is never silent. | Anything in the files it declined to read, or leaked text the heuristic passes — **read the scope it prints**; it covers starforge's own data directory, not your disk. Also: files already synced away or deleted, encodings the patterns don't know, a `--join-fleet` dir you pointed elsewhere, and the things a report carries **by design** (project names, hostname, `acct-<hash>` labels) which are not flagged because they are not leaks — they are still a list of what you work on. A PASS here is "the leak scan found nothing", never "there is nothing to find". |
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

# per-process network bytes in/out, 5 samples (macOS, no sudo needed):
nettop -P -p $PID -L 5
```

Both of those run unprivileged and were run as written on macOS 15 while
writing this page. (`lsof` exits non-zero when a pid has no matching sockets —
that is the answer you want, not an error.)

Caveats, honestly: `lsof` samples — a socket that opens and closes between
samples can be missed — and child processes have their own pids. A packet
capture has no sampling gap, but it **needs root** and it is per-interface:

```
tcpdump -D                       # no sudo: list interfaces, pick your active one (e.g. en0)

# macOS — one active interface at a time (NEEDS SUDO):
sudo tcpdump -i en0 -n 'not (host 127.0.0.1 or host ::1)'

# Linux — the 'any' pseudo-device covers all interfaces at once (NEEDS SUDO):
sudo tcpdump -i any -n 'not (host 127.0.0.1 or host ::1)'

# then, in another terminal:
node src/cli.mjs --yes
```

macOS has **no `any` device** — `tcpdump -i any` there fails with
`ioctl(SIOCIFCREATE): Operation not permitted` because it tries to *create* an
interface by that name; `tcpdump -D` lists no `any`. (An earlier version of
this page gave the Linux form under a macOS heading. Verified on macOS 15:
`-i any` fails as above, `-i en0` reaches the normal "you don't have permission
to capture on that device" BPF error, which is what sudo fixes.) macOS also has
a `pktap` pseudo-device — `sudo tcpdump -i pktap,all` is the all-interfaces
form — but it too must be created as root, so it is untested here; if you want
a verified path, run one `sudo tcpdump -i <iface>` per interface that
`tcpdump -D` shows as `Up, Running` and associated.

This whole section watches sockets. It cannot see filesystem egress (§6).

For a per-process answer with no sampling gap, combine with §1: confinement
plus tcpdump showing nothing is as closed as this question gets.

---

## 4. The audit log

Every run writes `~/.starforge/audit/run-<timestamp>.json` (schema v2):
what was read (source → count), the files written **through the audited path**
— the report files (`--json` / `--card` / `--page`), the monthly snapshots, and
the per-month star SVGs under `~/.starforge/stars` —
each as masked path + sha256 + bytes, the sha256 of every source file that ran
and a combined `source_hash` (compare it to the tree you audited), any tripwire
hits, argv (redacted), the confinement mode *claimed* for the run, a monotonic
`run_index`, and `prev_log_sha256` — the hash of the previous log, forming a
chain. `starforge-cli verify` re-walks the chain.

**Writes it does NOT list:** a `--join-fleet` directory is written by
`src/fleet.mjs` outside the audited path, so those files are absent from
`writes`. Every log states this in its own `writes_scope` field — read that,
not this page.

**The confinement field is a label, not evidence.** Two shipped paths set
`STARFORGE_CONFINEMENT` on the sandboxed child so the log can record which
sandbox the run claims to have been launched under: `bin/starforge-proof.sh`,
and the command `prove` prints for you to run (it is built by
`buildProofCommand()`, which launches the child through `/usr/bin/env
STARFORGE_CONFINEMENT=<mode>` — that is why the printed string and the executed
process cannot drift apart). `src/confine.mjs` also exports `runConfined()`,
and **the CLI does now call it**: pressing `[p]` at the end-of-run menu runs the
three-step proof for you — the probe outside the sandbox (must connect), the
same probe inside it (the kernel must refuse), and the scan itself under the
sealed network. That path exists because a proof you have to assemble by hand is
a proof most people never run, and an unrun proof convinces nobody. It is still
the **weaker** form and says so on screen: starforge is running a check on
starforge, and a build that wanted to lie could lie there. The strong form is
unchanged and is one line away — `sh bin/starforge-proof.sh`, run by you, in
your shell, where this process gets no vote. And the bare §1 command
above sets nothing: run it by hand and the log records `"none"` for a run that
really was confined. Any process can set that variable, and none of this is
evidence. That is why the log stores it with `verified: false`: only §1, run by
you, proves a run was confined.

**The suffix limit, stated plainly:** the chain only protects a log that a
LATER log still vouches for. Any *suffix* of the history — the newest log, the
newest ten, or all of them — can be rewritten or deleted with a self-consistent
chain; what the chain catches is an edit, deletion or reorder in the MIDDLE of
a history whose tail is intact. Two gap checks raise the cost of the rest: the
oldest log on disk must be a genesis log (`prev_log_sha256: null`), and
`run_index` is mirrored in `~/.starforge/audit-counter.json`, which lives
**outside** the audit dir — so deleting the oldest logs, the newest logs, or
the whole dir leaves a numeric gap that `verify` reports as a break. Whoever
can write the audit dir can rewrite that counter too: this costs an attacker
more steps, it does not stop one. Tamper-evident bookkeeping by the very
process it describes — worthless as cryptographic attestation. Treat it
accordingly.

**Retiring a history you don't want: `--reset-audit`.** There is no partial
delete, by design — pull one log out of the middle and the chain breaks for
every log after it, and nothing here will re-stitch it, because a chain you can
quietly repair is not evidence of anything. That used to be a bind with no
exit: a log written by an older version can fail today's leak scan, and
deleting it by hand breaks the chain instead. The supported way out:

```
node src/cli.mjs --reset-audit="why I did this"   # or: starforge-cli --reset-audit
```

It deletes every run log in `~/.starforge/audit` and starts a new chain whose
**genesis records the deletion**: how many logs, their `run_index` range, the
sha256 of each removed log, and your reason. It does not roll the run counter
back, so how much history existed stays visible, and `verify` prints the reset
under the audit-chain check from then on. Nothing is scanned by that command.

Be clear about what that record is: it proves logs were *removed*, and it lets
a copy you kept be matched by hash. It is not a copy of them and not proof of
what they said. If you delete logs by hand instead, delete
`~/.starforge/audit-counter.json` along with them — otherwise `verify` keeps
reporting the gap, which is exactly what it is for.

**A run that dies still leaves a log.** The log is written the moment a
tripwire fires, and again from an exit hook, so a tripwire hit or an uncaught
error still reaches the disk — marked `complete: false` with a masked
`abort_reason`, and still counted by `verify`. Read the `abort_reason` before
concluding anything from it; `complete: false` means "this run did not reach
its normal end", which is a fact about the run, not by itself a fault. SIGKILL,
a power cut or a full disk leave nothing: absence of a log is not evidence of
absence of a hit.

---

## 5. Supply chain: the tarball you run vs the tree you grepped

`npx starforge-cli` will execute a tarball from the npm registry. A grep of
this repo proves **this repo** — it proves nothing about that tarball unless
you check they match.

**First, the name.** The package is `starforge-cli`. `npm pack starforge` (no
`-cli`) succeeds and hands you an unrelated 2017 package whose entire contents
are a single `package.json` — no `src/`, no `bin/`. That is the failure mode
this section exists to catch, so it is the first thing to check:

```
tar -tzf <the .tgz you fetched> | grep -E '^package/(src|bin)/' | sort
# expect the whole source tree under package/src/ plus package/bin/starforge-proof.sh
# (don't pipe to `head` — npm interleaves the tarball listing, bin/ lands last)
```

If there is no `package/src/`, you fetched a different package. **Stop.**

**Then, the hashes.** npm publishes two, and they are *different algorithms*:
`dist.shasum` is **SHA-1** (hex) and `dist.integrity` is `sha512-` +
**base64(SHA-512)**. A SHA-256 of the tarball matches neither — an earlier
version of this page told you to compare one, so a correct tarball looked
tampered. The commands that do match:

```
npm pack starforge-cli@<version> --silent          # fetches the EXACT published artifact
npm view starforge-cli@<version> dist.shasum dist.integrity

shasum -a 1 starforge-cli-<version>.tgz            # must equal dist.shasum
openssl dgst -sha512 -binary starforge-cli-<version>.tgz | base64
                                                   # must equal dist.integrity WITHOUT its "sha512-" prefix
```

**Then, the contents:**

```
tar -xzf starforge-cli-<version>.tgz               # unpacks into ./package
diff -r package/src <your-audited-checkout>/src
diff package/package.json <your-audited-checkout>/package.json
```

Any difference under `src/` means you are not running the code you read — stop
and read the diff. `diff -r` prints `No such file or directory` (not a diff) if
`package/src` is missing, which is the wrong-package case above.

**Comparing against a tarball you build yourself.** The registry commands above
work against the published package (`starforge-cli@0.6.1`). This variant needs
no network at all — it packs THIS checkout and is how the hash algorithms above
were verified in the first place. Running both and comparing the two shasums is
the actual check that what npm serves is what this tree builds:

```
npm pack --pack-destination /tmp/sfpack --json     # packs THIS checkout; prints filename, shasum, integrity
shasum -a 1 /tmp/sfpack/starforge-cli-0.6.1.tgz                     # equals the printed shasum (SHA-1)
openssl dgst -sha512 -binary /tmp/sfpack/starforge-cli-0.6.1.tgz | base64
                                                   # equals the printed integrity, minus "sha512-"
tar -xzf /tmp/sfpack/starforge-cli-0.6.1.tgz -C /tmp/sfpack
diff -r /tmp/sfpack/package/src ./src              # expect: no output
```

Both hash commands were run this way and reproduced npm's own `shasum` and
`integrity` values exactly, and the `diff -r` printed nothing.

One honest caveat: do **not** expect `npm pack` on your machine to be
byte-identical to the published tarball — packing depends on the npm version
and file modes, so hashes can differ for identical code. Compare *hashes*
between the file you downloaded and the registry's record of that file;
compare *code* with `diff -r`. They answer different questions.

You can also point the warden at the unpacked tarball itself:
`node package/src/verify.mjs`, and run its test suite —`tests/` ships in the
package on purpose — with `node --test package/tests/`. And §1 works on the
tarball too, which is the backstop when you don't want to diff at all: run the
unpacked package under confinement and the provenance question stops mattering
for egress.

---

## 6. Filesystem egress — the blind spot every socket check has

A process needs no socket to leak data: **a file written into a cloud-synced
folder or a network mount leaves the machine later, carried by your sync
agent.** Neither the static scan, nor the tripwire, nor `tcpdump` on this
process, nor the §1 sandbox will ever flag that — the write is local and
legitimate as far as the kernel is concerned.

What starforge writes, exhaustively:

- `~/.starforge/` — reports, snapshots, per-month star SVGs (`stars/`), audit
  logs. Nothing else, ever,
  unless you ask.
- `--join-fleet=DIR` — a directory **you** name. If you name a synced or
  network-mounted directory, its contents leave the machine **by design** —
  that flag exists precisely to share fleet stats across machines. The same
  applies if you sync `~/.starforge/snapshots` between machines, which the
  README suggests: that is deliberate egress under your control.

So the honest statement is: starforge's outputs stay local **until you place
them somewhere that syncs**. What makes that acceptable is what's *in* the
files — masked paths, redacted secrets, aggregates instead of transcripts —
which the `output-scrub` check inspects within the scope it prints (§2), and
which you can read yourself: `~/.starforge` holds plain JSON/SVG/HTML, nothing
encoded. Check whether a destination is a mount before pointing `--join-fleet`
at it: `df -P <DIR> | tail -1`.

# starforge

Privacy-first developer wrapped. One command, everything stays on your machine.

```bash
npx starforge
```

Scans your local AI-coding session logs (Claude Code, Claude Cowork, Codex) and
builds your skill star live in the terminal — Porter-Grade style, five axes,
each ray growing as the scan runs.

```
                 FIRST PRINCIPLES LV.5
                        ✦
   TENACITY LV.4   ✦    *    ✦   ENGINEERING LV.5
                     *  *  *
  OUTSIDE THE BOX ✦    * *    ✦ CODING LV.4.6
              SKILL POINTS 21.5/25
```

## Why this exists

Tools like `npx standout` read the same local logs — but they upload prompt
samples, full user/assistant exchanges, raw file paths, and project names to a
remote service, with only a thin regex pass over a dozen token formats.

starforge is the verifiable alternative:

| Area | What starforge does |
|---|---|
| **Credential redaction** | 25+ secret patterns (SSH keys, PEM blocks, provider tokens, JWTs, connection-string passwords, 32-byte hex keys) **plus** labeled-assignment and `ENV_VAR=value` detection — applied *before* anything is stored or written |
| **Path masking** | Home directory, username, and deep local paths masked everywhere; projects reduced to two-segment labels |
| **Interactive exclusion** | Asks before scanning which folders/topics to exclude entirely |
| **Metadata over transcripts** | Reads the low-level token-usage records (deduped by message id) and session metadata — it never stores prompt text or conversation content at all |
| **Multi-account / multi-machine** | `--roots` merges log stores from other home directories; the snapshot dir is designed to be synced between machines and merges per-month per-host |
| **Rolling snapshots** | Every run updates `~/.starforge/snapshots/YYYY-MM.json` — your history survives the ~30-day retention of the raw logs |
| **Velocity tracking** | Month-over-month deltas + linear trend across every snapshot |
| **Open & verifiable** | Small, dependency-free, readable source with zero network code in this tree — a claim `starforge verify` checks mechanically, and [PROVE-IT.md](PROVE-IT.md) shows what it does and doesn't cover |
| **Dual output** | `--json` writes both a compact baseline stat block and the full expanded (pre-redacted, pre-masked) report |

## Usage

```bash
npx starforge                  # interactive: prompts for exclusions, live star
npx starforge --yes            # no prompts
npx starforge --json           # also write baseline + expanded JSON reports
npx starforge --roots=/Volumes/other-mac/Users/me   # merge another machine's logs
npx starforge --no-snapshot    # don't touch ~/.starforge/snapshots
```

## The five axes

| Axis | Fed by |
|---|---|
| FIRST PRINCIPLES | total tokens exchanged (depth of work) |
| ENGINEERING | distinct projects + languages (breadth) |
| CODING | tool calls executed (volume) |
| OUTSIDE THE BOX | model diversity + late-night activity |
| TENACITY | streaks + active days (consistency) |

## Privacy model

Two claims that sound alike but need different proof — we keep them separate:

1. **"There is no network code in this source tree."** This one is checkable
   text: grep it, or run `starforge verify`, which scans every source file for
   network/process APIs and fails on any hit outside two allowlisted safety
   files (`src/tripwire.mjs`, which imports network modules only to disarm
   them, and `src/confine.mjs`, the sandbox launcher and positive-control
   probe). It's a claim about *this repo* — CI can enforce it — but note that
   `npx` runs the published tarball, not the tree you grepped; PROVE-IT.md §5
   has the recipe to diff them.
2. **"Nothing left your machine at runtime."** No grep and no in-process check
   can prove this — worker threads, spawned processes, and low-level bindings
   all live below what a source scan or a JS-level tripwire can see. The only
   real proof is OS-level confinement: run starforge under macOS `sandbox-exec`
   with a deny-network profile, or a Linux network namespace (`unshare -rn`),
   and the kernel refuses any outbound connection — including a built-in
   positive control that *attempts* one so you can watch it be refused.
   PROVE-IT.md §1 has the exact commands.

Also true, and worth knowing:

- Raw logs are read as streams; only aggregates survive — starforge never
  stores prompt or conversation text, and the `verify` output-scrub check
  re-scans everything on disk for transcript-sized strings.
- Every string that could carry a path or secret passes through
  `src/redact.mjs` before it reaches memory structures that get written out.
- Snapshots and reports contain masked paths only, so they're safe to sync —
  but syncing **is** the one way starforge output leaves your machine, and
  pointing `--join-fleet` at a synced or network-mounted folder ships those
  files by design. No socket check can see that; PROVE-IT.md §6 spells it out.

## Prove it

Don't take this README's word for any of the above. [PROVE-IT.md](PROVE-IT.md)
is the step-by-step verification guide, strongest proof first: OS confinement
with a kernel-refused positive control, what each `starforge verify` check does
and does not cover, watching the process from outside with `lsof`/`nettop`/
`tcpdump`, the tamper-evident audit log and its honest limits, checking the npm
tarball against this repo, and the filesystem-egress caveat.

MIT

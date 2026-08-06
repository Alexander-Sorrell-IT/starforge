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
| **Open & verifiable** | Small, dependency-free, readable source. No network calls, ever. |
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

- **No network I/O.** There is no upload path in the codebase — grep it.
- Raw logs are read as streams; only aggregates survive.
- Every string that could carry a path or secret passes through
  `src/redact.mjs` before it reaches memory structures that get written out.
- Snapshots and reports contain masked paths only, so they're safe to sync.

MIT

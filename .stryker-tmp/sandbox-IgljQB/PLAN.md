# starreckon — concrete build plan

Derived entirely from reading the code. No item here came from a document.
Every "confirmed missing" claim has a grep that returned no output.
Every "confirmed present" claim has a grep or file read that showed the code.

Run `npm test` and `python3 /home/phantomcore/deadreckon-count/status.py` to
see the live state. Those are the authority. This file is the work queue.

---

## DEFECTS — wrong right now, confirmed by status.py

### D1 · deadreckon token gap
**What:** `lifetime.json` publishes 84,885,313,145 tokens.
`status.py` reports the machine folder sum differs by ~3.3M.
**Where:** `check_consistency.py` — the gap is between what `run.py update`
publishes and what the machine folder tree holds.
**Fix:** run `python3 check_consistency.py` on the deadreckon machine,
find which machine/CLI the gap is in, rescan that machine.
**Blocker:** needs tracing. Can do from this machine.

---

## MISSING FEATURES — not in code, confirmed by grep

### F1 · `serve` runs a fresh scan inline
**What:** `starreckon serve` currently calls `startServe()` with no `html` arg
(cli.mjs:559). If `--page` was never run, the browser gets "no page yet".
**Fix:** in the `serve` branch (cli.mjs:553–565), run the full scan pipeline
then pass the rendered HTML directly to `startServe({ html })`. The `html`
override already exists in `startServe` for exactly this purpose.
**Files:** `src/cli.mjs` only. ~50 lines.
**Tests:** existing serve tests cover `opts.html` path already. Add one
end-to-end CLI test that runs `serve` and confirms it exits cleanly.

### F2 · Wider star on wide terminals
**What:** star canvas is fixed at W=78 columns regardless of terminal width.
On a 180-col terminal it is a small island of cyan.
No `process.stdout.columns` anywhere in `starsvg.mjs` or `star.mjs`.
**Fix:** at render time in `renderStar()`, read `process.stdout.columns`.
If ≥140 use W=120; if ≥100 use W=96; else keep W=78. Scale R proportionally.
All geometry is already parameterised — just change the constants passed in.
**Files:** `src/starsvg.mjs` only. ~5 lines.
**Tests:** `tests/star.test.mjs` — add cases with stubbed `stdout.columns`.

### F3 · Desktop folder restructure + auto fleet
**What:** current Desktop output is a flat pile of dated folders:
```
~/Desktop/starreckon/
  2026-08-17_11-18/       ← report.txt + star.svg
  2026-08-17_14-22/
```
No fleet subfolder. No date hierarchy. `--fleet` and `--join-fleet` require
a path typed by hand every run.

**Target:**
```
~/Desktop/starreckon/
  data/
    ledger.jsonl                        ← lifetime, all sessions
    2026/
      ledger.jsonl                      ← year rollup
      2026-08/
        ledger.jsonl                    ← month rollup
        snapshots/
          2026-08.json                  ← copy of ~/.starreckon/snapshots/2026-08.json
        week-33/
          ledger.jsonl                  ← week rollup
          2026-08-17/
            ledger.jsonl                ← sessions from this date only
            report.txt
            star.svg
  fleet/
    ledger.jsonl                        ← fleet lifetime, union of all machines
    hp-phantom-core/                    ← this machine, written every default run
      totals.json
      sessions.json
      token_ledger.jsonl
      months/
        2026-08.json
    macbook-air-m1/                     ← written by mode 1 or mode 2 when heard
      totals.json
      sessions.json
      token_ledger.jsonl
      months/
        2026-08.json
```

**Rules:**
- Every default run writes `data/.../YYYY-MM-DD/` + updates `fleet/<hostname>/`
- Mode 1 (`--beacon`): as each peer is heard, writes `fleet/<peername>/`
- Mode 2 (`--live`): same, overwrites on each update
- `--fleet` with no `=DIR` defaults to `~/Desktop/starreckon/fleet/`
- `--join-fleet` with no `=DIR` defaults to `~/Desktop/starreckon/fleet/`
- Ledger at each level = sessions filtered from `~/.starreckon/token_ledger.jsonl`
  by date. Not a separate counter — a view. Undated sessions appear in
  lifetime ledger only.
- Snapshots copied into `data/<year>/<month>/snapshots/` each run.

**Files:** `src/cli.mjs` (`writeDesktopReport`, beacon handler, fleet defaults).
**Build steps (independent, can be done in any order):**
```
F3a  Auto-write fleet/<hostname>/ on every default run — no flag needed
F3b  --fleet / --join-fleet with no =DIR default to Desktop fleet folder
F3c  Restructure data/ into year/month/week/day hierarchy
F3d  Write ledger at each level (filter token_ledger.jsonl by date)
F3e  Copy snapshots into data/<year>/<month>/snapshots/ each run
F3f  Mode 1 (--beacon): write fleet/<peername>/ as peers are heard
F3g  Mode 2 (--live): overwrite fleet/<peername>/ on each peer update
```

### F4 · Undated sessions surfaced in starreckon
**What:** starreckon has 97 sessions with no `start` date. They are counted
in the total but the user never sees the gap between "dated total" and
"all sessions total". deadreckon publishes this explicitly; starreckon does not.
**Confirmed missing:** grep for `undated` in `src/cli.mjs` returns nothing.
**Fix:** after the summary block, if `agg.sessions_without_date > 0` (or
equivalent field), print one line:
`⚠ N sessions (X tokens) have no date — counted in total, not in any month`
**Files:** `src/cli.mjs` + `src/scan.mjs` (add the count to agg if absent).

### F5 · copilot-chat session-id dedup in starreckon
**What:** deadreckon deduplicates copilot records on `session_id` across every
workspace and base. starreckon pushes one session object per FILE, so one
session opened in two workspaces counts twice. Zero effect on real data today
(all 75 real files have 75 distinct session IDs) but structurally wrong.
**Fix:** in `src/readers.mjs`, after collecting copilot-chat sessions, deduplicate
by `session_id` keeping the max-token observation, same rule as the ledger.
**Files:** `src/readers.mjs`.

### F6 · `addons` as launcher
**What:** `starreckon addons` reports which companion tools are licensed and
installed. It never runs any of them. Making it run a companion tool would
turn it from a report into a front door.
**Note:** MCP servers should get their config emitted, not be spawned —
they are stdio servers for an MCP client.
**Files:** `src/cli.mjs` (addons branch), `src/addons.mjs`.

### F7 · Scoreboard
**What:** signed summary → manual submission → public ranking.
**Design decision (from ROADMAP.md):** manual submission only, nothing
automatic. A submitted figure carries an Ed25519 signature over it — the same
primitive `src/addons.mjs` already uses. Summary only: counts, no transcripts,
no paths, no prompt text.
**Order matters:** build the signing first, then the submission target,
then the ranking. A leaderboard before the signing is unverifiable.
**Files:** new `src/scorecard.mjs`, new `docs/scoreboard/index.html`,
update `src/cli.mjs` (new `scoreboard` subcommand).

---

## WARNINGS — not wrong, needs action eventually

### W1 · deadreckon fleet on two scanner versions
HP Laptop Linux stamped `5cda394`, MacBook Air M1 stamped `103c20d`.
Fleet total mixes two accountings.
**Fix:** rescan M1 (`run.py update` on the M1).
**Blocker:** physical M1 access.

### W2 · hp-laptop-linux stamp names no commit
Stamped `5cda39428705` but names no git commit, so nothing independent
can verify it against the source.
**Fix:** `run.py update` records the git commit when it stamps — confirm
it is doing so, or add it.

### W3 · deadreckon COVERAGE.md gate never run
`COVERAGE.md` not on disk, never committed to `deadreckon-record`.
The gate that should certify it has never fired.
**Fix:** write `COVERAGE.md` into the deadreckon-record checkout and
run the gate.

### W4 · 97 undated sessions in deadreckon
These are sessions with no `start` timestamp. They are in the every-CLI total
(35.9B) but not in any dated breakdown. Already surfaced in `LIFETIME.md`.
No code change needed — already handled.

---

## NEEDS PHYSICAL ACCESS

### P1 · cowork tokens (deadreckon)
Discovery is written and tested against a synthetic store. No reader, no store
entry, no number. The store is macOS-only.
**Action:** on the M1, run:
`ls ~/Library/Application\ Support/Claude/local-agent-mode-sessions`
then `run.py update`.

### P2 · M1 rescan to unify scanner versions
**Action:** `run.py update` on the M1 after any scanner code change.

### P3 · 5 unscanned machines
dell-inspiron-desktop-linux, dell-latitude-7480-linux ×2, asus-laptop-linux,
hp-laptop-linux (second scan).
**Action:** SSH or physical access to each. Run `install.py --apply` then
`run.py update`.

---

## NEEDS YOUR npm TOKEN

### N1 · npm publish
`npm pack --dry-run` passes. Package is v0.14.0. README is current.
**Action:** `npm publish` with your `npm_...` token.
**Pre-check:** run `node src/cli.mjs verify` first.

---

## Build order (what can be done from this machine, smallest first)

```
1   F2   Wider star on wide terminals          src/starsvg.mjs  ~5 lines
2   D1   Trace deadreckon token gap            check_consistency.py
3   F1   serve inline scan                     src/cli.mjs  ~50 lines
4   F4   Undated sessions in starreckon        src/cli.mjs + scan.mjs
5   F3a  Auto-write fleet/<hostname>/          src/cli.mjs
6   F3b  --fleet / --join-fleet default dir    src/cli.mjs
7   F3c  Desktop date hierarchy                src/cli.mjs
8   F3d  Ledger at each level                  src/cli.mjs
9   F3e  Snapshots into Desktop data/          src/cli.mjs
10  F3f  Mode 1 writes fleet peers             src/cli.mjs
11  F3g  Mode 2 updates fleet peers            src/cli.mjs
12  F5   copilot-chat session dedup            src/readers.mjs
13  F6   addons launcher                       src/cli.mjs + addons.mjs
14  F7   Scoreboard                            new files
```

Items 1–4 are independent of each other.
Items 5–11 (F3 series) should be done in order — each builds on the previous.
Items 12–14 are independent of everything else.

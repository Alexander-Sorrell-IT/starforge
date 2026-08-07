# starforge

A local-only **developer wrapped** for AI-coding work. It reads the session logs
Claude Code, Claude Cowork and Codex already wrote on your disk and turns them
into a Porter-Grade skill star — live in the terminal while it scans, then as a
self-contained SVG card and a full HTML stats page. No account, no upload, no
server-side scoring. The thesis is not "trust us": **run it under OS confinement
and let the kernel answer.**

**Status:** published as **`starforge-cli`**, source at
`github.com/Alexander-Sorrell-IT/starforge`. Zero dependencies. Install the
`-cli` name — bare `starforge` on npm is an unrelated 2017 package, **not this
tool** ([Install](#install--about-the-name)).

```bash
npx starforge-cli                       # scan, with the live star
npx starforge-cli --yes --card --page   # no prompts; also write the SVG card + HTML page
git clone https://github.com/Alexander-Sorrell-IT/starforge.git && cd starforge
node src/cli.mjs                        # or read the source first, then run the tree you read
```

One real frame of the live star, rendered with colour disabled and the middle
rows elided — the whole 78×26 frame, verbatim, is under
[What you get](#what-you-get):

```


                            FIRST PRINCIPLES LV.4.8

                    …  6 rows elided  …
   TENACITY LV.4.5      ██████▒▒▒▒▒▒██▒▒▒██▒▒▒▒▒███████     ENGINEERING LV.4.6
                    …  10 rows elided  …
   OUTSIDE THE BOX LV.4.4                            CODING LV.4.7
                    …  3 rows elided  …
                     SKILL POINTS 23.0/25  scan complete
```

## Why this is not `npx standout`

`npx standout` reads the same local logs — and then **uploads** what it pulled
out of them to a remote service that scores you server-side. starforge computes
the same class of signals **in this process, on your machine**, stores no
transcript text at all, pseudonymises your account identity in every file it
writes, and hands you an OS-level way to check all of that yourself.

Stated in two registers, because they have different kinds of backing:

**Checkable in this tree, right now.** `src/profile.mjs` computes the
judgment-signal metrics (correction rate, question ratio, prompt depth,
delegation, tool mix, concurrency) by reading prompt text *in-stream to
increment counters* and never storing it — no `exchanges`, no `prompt_samples`,
no `prompt_frequency`, no `conversation_samples`. Grep it; the privacy contract
is written at the top of the file, and `starforge-cli verify` re-reads the
output files afterwards looking for transcript-sized strings.

**Read from the standout CLI bundle (August 2026), so re-read it yourself
before quoting it — a vendor can change this at any release:** its payload caps
out around **4 MB**, and carries project paths, prompt samples, and up to
**500 full user/assistant exchange pairs**. Those field names are where
`src/profile.mjs` gets its metric lineage — the formulas were ported from that
bundle deliberately, so the comparison is like-for-like.

| | `npx standout` | starforge |
|---|---|---|
| Where scoring happens | on their server, after an upload | in this process, on your machine |
| What travels | up to ~4 MB: project paths, prompt samples, up to 500 exchange pairs (per their bundle, Aug 2026) | nothing on the scan path; outputs are files under `~/.starforge` until *you* move them |
| Transcript text | uploaded as samples/exchanges | never stored — counted in-stream, then dropped |
| Your identity in files | — (not a claim we make about their service) | `acct-<hash>` pseudonym in every file; the address stays on your terminal |
| How you check it | read their client; the scoring happens somewhere you can't watch | run it under a deny-network sandbox and read the kernel's answer |

A dash means we do not claim to know. This is a comparison of mechanisms, not
a swipe: standout's design is a reasonable one for a hosted product, and this
project ports its formulas on purpose. The difference is where the computation
happens and what you are able to verify.

## Prove it: the kernel refuses, and you can watch it happen

A no-egress claim that never *tries* to cross the wall proves nothing. So
`src/confine.mjs` ships a deliberate positive control — it really opens a TCP
connection to 1.1.1.1:443 — and you run it on both sides of the wall. Verbatim
output from this machine (macOS 15, Node 20):

```
# OUTSIDE the sandbox — proof the probe is a real network attempt:
$ node src/confine.mjs --probe
egress attempt: TCP 1.1.1.1:443 (timeout 3000ms)
result: NOT BLOCKED — connected to 1.1.1.1:443 — egress is OPEN in this context

# INSIDE the sandbox — the same attempt, refused below the JS layer:
$ sandbox-exec -p '(version 1)(allow default)(deny network*)' node src/confine.mjs --probe
egress attempt: TCP 1.1.1.1:443 (timeout 3000ms)
result: BLOCKED — EPERM on connect() — the kernel refused before any packet could leave (connect EPERM 1.1.1.1:443 - Local (0.0.0.0:0))
```

That contrast *is* the product. The errno in parentheses is the part that makes
it a kernel refusal rather than a story about one — a timeout is deliberately
**not** counted as blocked, because dropped packets may still have left the
machine.

```bash
sh bin/starforge-proof.sh   # runs a real scan inside the deny-network sandbox,
                            # plus both control probes, and prints
                            # PASS / FAIL / INCONCLUSIVE
```

Nothing in that script trusts starforge: it hands the question to the OS. On
Linux the same proof is `unshare -rn`. `node src/cli.mjs prove` prints the
profile and the exact command **without running anything**, so you can read the
proof before you trust it. [PROVE-IT.md](PROVE-IT.md) has the whole ladder,
strongest first, with what each rung does *not* prove.

## What you get

**A skill star that builds while it scans.** `src/star.mjs` redraws a five-axis
78×26 frame in place in the terminal every five files, so you watch the arms
grow as the logs are read. It is drawn as an image, not as character art: each
cell carries two pixels (the half-block `▀` painted in the foreground colour
over a background colour), the shape is supersampled for anti-aliasing, and
because a terminal cell is about twice as tall as it is wide those pixels come
out roughly square. Below is one whole frame, verbatim from `renderStar()` with
colour disabled — the colour version shades the same field through a 256-colour
ramp instead of the `░▒▓█` density ramp you see here. A test asserts this exact
block still matches the renderer, so the README cannot drift from the binary:

```


                            FIRST PRINCIPLES LV.4.8

                                       ▒
                                      ▒█▒
                                      ███
                                     ▒███▒
                                     ██▒██
                                    ▒█▓▒▓█▒
   TENACITY LV.4.5      ██████▒▒▒▒▒▒██▒▒▒██▒▒▒▒▒███████     ENGINEERING LV.4.6
                        ▒████████████▓▒▒▒▓████████████▒
                           ▒████▓▒▒▒▒▒▒▒▒▒▒▒▒▒▓████▒
                              ░████▒▒▒▒▒▒▒▒▒████░
                                 ▒█▓▒▒▒▒▒▒▒▓█▒
                                ▒█▓▒▒▒▓█▓▒▒▒▓█▒
                               ░██▒▒███████▒▒██▒
                               ██▓███░   ░███▓██░
                              ▓███▒         ▒████
                              ██░             ▒██▒

   OUTSIDE THE BOX LV.4.4                            CODING LV.4.7



                     SKILL POINTS 23.0/25  scan complete
```

Redrawing in place needs a TTY. Piped or redirected, the frame is printed once
at the end instead of animating — same numbers, no cursor tricks.

**`--wrapped` — the paced story.** Twelve boxed cards, one keypress at a time,
in the format everyone already recognises from a hosted wrapped: the shape of
your work, hours, history, tokens (with a cost estimate), the month-by-month
silhouette, when you code, how you drive the machine, how many agents you juggle,
tools and models, top projects, and a share card with a QR you can scan off the
screen. Piped or `--no-pace`, the whole story prints at once.

Two differences from a hosted wrapped, and they are the point. **There is no
"top 17% of users" anywhere in it** — this tool has never seen anyone else's
data, so it benchmarks you against *your own months*, which you can check
against the snapshots on your disk. And the last card accounts for what left the
machine: nothing, plus the command that makes the kernel prove it rather than
asking you to believe it.

The cost estimate is arithmetic on **assumed** rates, printed on the card next
to the number and overridable with `--rates=in,out,cached`. Nothing is ever
fetched — this tool makes no network calls, so it cannot know today's prices.
Sanity-check the figure before quoting it anywhere that matters.

**The silhouette is the data.** Each arm's length is set by its own axis and by
nothing else, and the valleys between arms sit at a fixed radius — so a maxed
axis is a long spike, a weak one is a stub, and the outline is a fingerprint you
read before you read a number. A lopsided star says "here is the actual shape of
this person"; a symmetric one says "balanced generalist". The defect that broke
this was in the **notch, not the arms**: an earlier version placed each valley at
the average of its two neighbouring levels, so the notch between a 5 and a 1 sat
at exactly the same radius as the notch between two 3s, and the outline stopped
telling those two profiles apart at the place it should have separated them
most. (Arm tips always tracked their own level — an adversarial review corrected
an earlier draft of this paragraph that claimed otherwise, and the test named
below was rewritten because it pinned a property the *buggy* version also had.)
`tests/star.test.mjs` now pins both halves: every valley sits at the fixed radius
whatever the five levels are, and raising one axis must lengthen that arm while
provably leaving the other four where they were. Level 0 lands on the valley ring rather than at the centre, so
the star floors at a regular pentagon and the hull can never self-intersect,
whatever the five levels are. The geometry lives in one module
(`src/starsvg.mjs`) and is shared by the terminal frame, the card and the month
chips, so what you watch during the scan is the shape that lands on disk — also
a test.

**A star per snapshot.** Each monthly snapshot gets its own star, computed
*only* from that month's activity, written to `~/.starforge/stars/YYYY-MM.svg`
(the most recent 36 months; the page strip shows the most recent 18 and says so)
and laid out as a strip on the stats page under "the shape over time". This is
the part a single lifetime-average star cannot show: the average is exactly what
hides a month where the shape changed. A thin month renders as a small tight
silhouette, not as a gap. To make that possible each snapshot carries its own
axis inputs (tool calls, language counts, project *count*, models, hour buckets,
active days, streak) — no path and no project name. All of them are counts
except the model ids, which are shape-checked and otherwise pseudonymised. What a
synced snapshot now discloses that it did not before is spelled out under
[what a report actually contains](#privacy-model);
"safe to sync" is your call to make with that list in front of you, not a
blanket claim this README gets to make for you. Where one month exists on more
than one machine the additive axes are summed, but **active days and streak take
the largest single machine's value, never the sum**: a calendar day you worked
on two laptops is one day, and two 4-day streaks are not an 8-day streak. The
day-sets themselves are not recoverable from the stored counts, so that axis is
reported as a floor rather than reconstructed.

**`--card` — a self-contained dark-HUD SVG.** 1280×720: a glowing pentagram web
with a reference ring per whole level, one node dot stepping out along each arm
per level it has actually reached, and a dashed all-fives outline behind the
hull so the gap between the two is the part not yet earned. The web and the
spokes are drawn at full extent, not at the current levels — the backdrop has to
hold still for the silhouette to be readable against it. Plus a letter RATING
(C / B / A / S / S+, off the skill total), a
SKILL OVERVIEW panel (total skill points, sessions, active hours) and an
ATTRIBUTES panel (tokens in+out, cache share, longest streak, active days,
velocity), footed `STARFORGE • LOCAL-ONLY SCAN • SECRETS REDACTED • PATHS
MASKED`. One file: system font names only, no webfonts, no scripts, and
nothing fetched when it renders — the only URL in the whole file is the SVG
namespace declaration. Open it in a browser or drop it straight into a README.
It lands in `~/.starforge/reports/star-<date>.svg`.

**`--page` — a full local HTML stats page.** That same SVG embedded inline as
the hero, plus panels for JUDGMENT SIGNALS, RHYTHM, TOKEN ECONOMICS, TOOLS &
MODELS, CRAFT and RECORDS — and ACCOUNTS / FLEET / PROVIDERS as well when the
run produced them (`--accounts`, `--fleet`, the multi-CLI scan). Rendered on
your machine, written to `~/.starforge/reports/stats-<date>.html`; like the
card, it references nothing remote. Read it before you share it — see "What a
report actually contains" below for exactly what is in there.

## Install — about the name

**The npm package is `starforge-cli`, not `starforge`.** The bare name was
registered on npm in 2017 by an unrelated maintainer (`resure`):
**`npx starforge` runs a stranger's package, not this tool — don't run it.**
This project is published as **`starforge-cli`** (`npm view starforge-cli`).
`npx starforge-cli` fetches a tarball from the registry, and **that tarball is
not the tree you grepped** — [PROVE-IT.md](PROVE-IT.md) §5 is the recipe for
checking the two match, which matters more now that there is something to
install than it did when there wasn't. The repo name (`starforge`) and the
package name (`starforge-cli`) differ on purpose; both are this project.

## Usage

The published name is on the left. Until it is published, swap `starforge-cli`
for `node src/cli.mjs` — the two rows below show the substitution; every other
line takes the same flags.

```bash
starforge-cli                  # node src/cli.mjs        interactive: prompts for exclusions, live star
starforge-cli --yes            # node src/cli.mjs --yes   no prompts (excludes nothing)
starforge-cli --card           # write the Porter-Grade SVG card
starforge-cli --page           # write the full HTML stats page (runs the deeper profile pass)
starforge-cli --json           # write both a compact baseline and the full expanded JSON report
starforge-cli --profile        # run the deeper profile pass without writing the HTML page
                               # (it lands in the expanded JSON report)
starforge-cli --accounts       # per-account split + floor (files get acct-<hash>, not addresses)
starforge-cli --no-projects    # write proj-<hash> into the files instead of project names
starforge-cli --show-accounts  # opt in: write the RAW account email addresses into the files
starforge-cli --no-providers   # skip the multi-CLI scan (Gemini/Copilot/…)
starforge-cli --no-snapshot    # don't touch ~/.starforge/snapshots or ~/.starforge/stars
starforge-cli --name=NAME      # title printed on the card and the stats page
starforge-cli --roots=/Volumes/other-mac/Users/me   # merge another machine's logs
starforge-cli --join-fleet=DIR [--machine=NAME] [--label=LABEL]   # write this machine's folder into a
                               # fleet dir (--machine/--label default to this machine's hostname)
starforge-cli --fleet=DIR      # read a fleet dir written by --join-fleet and print the rollup
starforge-cli --reset-audit[=WHY]   # retire the run-log history: deletes the logs and records the
                               # deletion in the new chain's genesis (PROVE-IT.md §4). Scans nothing
starforge-cli verify           # the adversarial self-check, with each check's limits printed
starforge-cli prove            # print (don't run) the OS-confinement proof command for this machine
```

An unknown flag exits 2 and reads nothing: `--no-project` (singular) used to be
ignored in silence while the run wrote every real project name, so flags now
fail closed rather than open. Same for an unknown subcommand.

`--join-fleet` is the one flag that deliberately writes outside
`~/.starforge`: it exists to merge several machines' totals, and if you point
it at a synced folder, those files sync. That is egress, by design and under
your control — [PROVE-IT.md](PROVE-IT.md) §6.

## What it does

| Area | What starforge does |
|---|---|
| **Credential redaction** | 23 secret regexes (SSH keys, PEM blocks, provider tokens, JWTs, connection-string passwords, 32-byte hex keys) **plus** labeled-assignment and `ENV_VAR=value` detection — 25 matchers in all, applied *before* anything is stored or written |
| **Path masking** | Home directory, username, and deep local paths masked everywhere — including the mangled `-Users-you-Projects-…` form Claude Code writes; projects reduced to two-segment labels |
| **Identity pseudonymisation** | Your Claude OAuth **email address** never reaches a file: reports, the stats page and a `--join-fleet` folder carry a stable `acct-<hash>` label instead (the terminal still shows the address). `--show-accounts` opts into raw addresses — see "What a report actually contains" below for the honest limit |
| **Interactive exclusion** | Asks before scanning which folders/topics to exclude entirely. `--yes` skips the prompt; so does a non-TTY stdin (a pipe, CI) — and in that case the run prints that it was skipped and that nothing was excluded, rather than letting you believe you were asked |
| **Metadata over transcripts** | Reads the low-level token-usage records (deduped by message id) and session metadata — it never stores prompt text or conversation content at all |
| **Multi-account / multi-machine** | `--roots` merges log stores from other home directories; the snapshot dir is designed to be synced between machines and merges per-month per-host |
| **Rolling snapshots** | Every run (unless you pass `--no-snapshot`) updates `~/.starforge/snapshots/YYYY-MM.json` — your history survives the ~30-day retention of the raw logs. Each snapshot carries its own axis inputs as **counts only** (no paths, no project names), which is what lets it draw its own star |
| **A star per month** | The same run writes `~/.starforge/stars/YYYY-MM.svg`, one silhouette per snapshot, each computed only from that month — the strip on the stats page is the shape changing over time, which the lifetime average hides |
| **Velocity tracking** | Month-over-month deltas + linear trend across every snapshot |
| **Open & verifiable** | Small, dependency-free, readable source. The only network code in this tree is one deliberate outbound probe in `src/confine.mjs` that exists to be refused, plus `src/tripwire.mjs` importing network modules only to disarm them — everything else is checked mechanically by `starforge-cli verify`, and [PROVE-IT.md](PROVE-IT.md) shows what that does and doesn't cover |
| **Tamper-evident run log** | Every run writes `~/.starforge/audit/run-<timestamp>.json`: what was read, what was written **through the audited path** (masked path + sha256 + bytes — a `--join-fleet` dir is written outside it, and each log's `writes_scope` field says so), the sha256 of every source file that ran, redacted argv, any tripwire hits, the confinement mode the run *claims* (`verified: false` — any process can set it), a monotonic `run_index` mirrored in a counter kept outside the audit dir, and the previous log's hash — a chain `verify` re-walks. Tamper-*evident*, not tamper-*proof*: PROVE-IT.md §4 states the limit plainly |

## The five axes

| Axis | Fed by |
|---|---|
| FIRST PRINCIPLES | total tokens exchanged (depth of work) |
| ENGINEERING | distinct projects + languages (breadth) |
| CODING | tool calls executed (volume) |
| OUTSIDE THE BOX | model diversity + late-night activity (events at 00:00–05:59, **counted**, not as a share of the day) |
| TENACITY | streaks + active days (consistency) |

Every axis is **monotonic**: more of its input can only lengthen its arm, never
shorten it. That is not decoration — late-night activity used to be scored as a
*share* of the day, so every daytime event shrank the OUTSIDE THE BOX arm and you
could watch it collapse mid-scan while starforge was still finding your work. An
axis whose arm answers to another axis's input is not an axis. `tests/star.test.mjs`
now fails if raising any input shortens any arm.

Day and hour are both read on your **local** clock. They disagreed once — hours
local, day boundaries UTC — which made an evening session in a US timezone count
as two active days with no midnight anywhere in its own hour histogram, and made
the whole star a function of `$TZ`.

## Privacy model

Two claims that sound alike but need different proof — we keep them separate:

1. **"This source tree contains no network code except one probe that exists
   to be refused."** This one is checkable text: grep it, or run
   `starforge-cli verify`, which scans every file this package *publishes* —
   the JS, the shell script, `package.json` — for network/process APIs and
   fails on any hit outside two allowlisted safety files
   (`src/tripwire.mjs`, which imports network modules only to disarm them, and
   `src/confine.mjs`, the sandbox launcher and positive-control probe — that
   probe is real, it really connects, and that is the point). Being on the
   allowlist is not a blank cheque: those two files are held to five further
   rules — a SHA-256 content pin (an edit to either fails the check), their
   disarm/launch code still being present (keeping the imports is not enough),
   every hit staying inside a per-file list of permitted APIs, no egress
   destination named other than the probe's own hardcoded target, and *zero*
   hits failing too, because zero means the safety code was gutted.
   Shipped **test** files are enumerated but deliberately not judged — a
   scanner's own test suite has to contain the strings it hunts — and the
   check prints that list rather than hiding it. It's a claim about *this
   repo* — CI can enforce it — but note that `npx` runs the published tarball,
   not the tree you grepped; PROVE-IT.md §5 has the recipe to diff them.
2. **"Nothing left your machine at runtime."** No grep and no in-process check
   can prove this — worker threads, spawned processes, and low-level bindings
   all live below what a source scan or a JS-level tripwire can see. The only
   real proof is OS-level confinement: run starforge under macOS `sandbox-exec`
   with a deny-network profile, or a Linux network namespace (`unshare -rn`),
   and the kernel refuses any outbound connection — including the built-in
   positive control quoted at the top of this page. PROVE-IT.md §1 has the
   exact commands; `sh bin/starforge-proof.sh` runs them for you.

Also true, and worth knowing:

- Raw logs are read as streams; only aggregates survive — starforge never
  stores prompt or conversation text. The `verify` output-scrub check re-reads
  every file under `~/.starforge`, at any depth and whatever the extension,
  looking for transcript-sized strings, secrets, email addresses and your
  literal username — and prints the exact scope it covered, including what it
  declined to read and why. Read that printed line rather than trusting this
  one: it is a scan of starforge's own data directory, not of your disk, and it
  is a heuristic, not a guarantee.
- Every string that could carry a path or secret passes through
  `src/redact.mjs` before it reaches memory structures that get written out.
- **What a report actually contains.** Paths are masked and secrets redacted,
  but "masked paths only" was never the whole truth, so here is the list: your
  **project names** (the last two segments of each working directory, e.g.
  `Clients/acme-audit`), this **machine's hostname** (in every snapshot and in the
  timeline), and — with `--accounts`/`--join-fleet` — one `acct-<hash>` label
  per Claude account. That is a de-identified list of *what you work on and
  where*.

  Since monthly snapshots started drawing their own stars they also carry, per
  month and per machine: a **24-bucket local-hour histogram**, the **model ids**
  you used, and a **project count**. None of those is a path or a name, but be
  clear-eyed about what a synced snapshot dir now shows a reader — the hour
  histogram is a work/sleep schedule keyed to a named machine, tracked month over
  month, and the project count is exactly the scope number `--no-projects` users
  are trying not to publish. Model ids are shape-checked before they are stored
  (letters, digits, `.` `:` `-`, 64 chars max); anything else becomes a
  `proj-<hash>` pseudonym, because that field is copied out of a log file and
  `--roots` can point the scanner at somebody else's logs.

  Two switches, and one thing you cannot switch off:
  - `--no-projects` writes `proj-<hash>` instead of every project label, in the
    reports, the stats page and a `--join-fleet` folder. The terminal keeps
    showing the real names.
  - the exclusion prompt drops folders from the scan entirely — but `--yes`
    skips the prompt and excludes nothing, and the PROVE-IT.md proof command
    passes `--yes`.
  - the **hostname** has no switch: snapshots are keyed on it so histories from
    several machines merge, and on a home network it usually carries the
    router-assigned domain too (`<laptop>.<isp-domain>`), which names your ISP.
    If that matters, don't sync `~/.starforge/snapshots`.

  Read a report before you share it. `starforge-cli verify` prints this same
  list under the output-scrub check.
- **Account identities are pseudonyms by default.** The identity starforge
  reads is your Claude OAuth **email address**. It is printed in the terminal,
  but files — reports, the HTML stats page, a `--join-fleet` folder — get
  `acct-<8 hex>` instead: a constant-salted SHA-256 prefix, stable across
  machines so per-account totals still merge. Honest limit: that hides your
  address from someone *reading* the file, but it cannot stop someone who
  already suspects an address from *confirming* it by hashing their guess. It
  is de-identification, not anonymity. `--show-accounts` writes the real
  addresses on purpose — and `verify` then fails until those files are gone.
- Syncing **is** the one way starforge output leaves your machine, and
  pointing `--join-fleet` at a synced or network-mounted folder ships those
  files by design. No socket check can see that; PROVE-IT.md §6 spells it out.

## Prove it (the long version)

Don't take this README's word for any of the above. [PROVE-IT.md](PROVE-IT.md)
is the step-by-step verification guide, strongest proof first: the one-command
scripted proof (`sh bin/starforge-proof.sh`), OS confinement with a
kernel-refused positive control, what each `starforge-cli verify` check does
and does not cover, watching the process from outside with `lsof`/`nettop`/
`tcpdump`, the tamper-evident audit log and its honest limits, checking the npm
tarball against this repo, and the filesystem-egress caveat.

MIT — see [LICENSE](LICENSE).

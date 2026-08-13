# starreckon — next steps roadmap

Current state: v0.13.1, 387/389 tests passing, committed to main.

---

## Phase 1 — Make it work end-to-end (this session)

### 1a. `serve --scan` — one command does everything
**Problem today:** `starreckon serve` shows "no page yet" unless you ran
`--page` first. Two commands, easy to forget the first one.

**Fix:** Wire the scan directly into serve. When `serve` runs:
1. Run the full scan (same path as a normal run)
2. Render the HTML page from the scan output
3. Start the LAN server with that HTML passed directly in (no file needed)
4. Print the QR + "ready — scan from any device on this WiFi"

**Implementation:** `cli.mjs` serve branch calls the same scan pipeline as the
main path, passes `html` directly to `startServe({ html })`. Adds
`--serve-port`, `--serve-timeout`, `--serve-visits` to the serve subcommand
(already registered in FLAG_SPEC, just not wired to the inline scan yet).

**Files changed:** `src/cli.mjs` (serve branch), `src/serve.mjs` (no change)

---

### 1b. Connection indicator
**Problem today:** when a phone connects, nothing visible happens in the terminal.

**Fix:** Print a live line when a device connects and when it disconnects:
```
  ✓ 192.168.1.47  connected     [visit 1/3]
  ✗ 192.168.1.47  closed (31s)
```
Uses `req.socket` events. 5 lines of code in `serve.mjs`.

---

### 1c. Tests for `serve.mjs`
**Problem today:** `startServe()` has zero tests.

**Tests to add (`tests/serve.test.mjs`):**
- `lanIp()` returns a valid IPv4 string
- Server binds a port and responds 200 to GET /
- Wrong path returns 404
- Correct HTML content is served
- Auto-shutdown fires after `maxVisits`
- Auto-shutdown fires after `timeoutMin`
- `opts.html` override works (for tests — no disk read needed)
- Error on already-used port is a readable message, not a stack trace

---

## Phase 2 — Make it look right (next session)

### 2a. Arm-tip animation
**Problem today:** the forge-pulse reveal grows all arms simultaneously to
partial values, then pops them in one at a time. The effect is choppy on slow
terminals and the intermediate frames look like a broken star.

**Better design:** each arm GROWS from the valley outward to its tip, one arm
at a time, at a constant pixel/frame rate. The label appears when the arm
reaches its tip.

**How:**
- Add `progress[]` array to `renderStar()` — one value per arm, 0→1
- `intensityAt()` clips arm length to `armRadius(level * progress[i])` per arm
- `LiveStar.finish()` drives `progress` from 0→1 over ~300ms per arm
- Total animation: 5 arms × ~300ms = ~1.5s, feels like watching a shape forge

**Cross-platform safe:** same ANSI cursor-up + redraw as today. No new deps.

---

### 2b. Wider star on wide terminals
**Problem today:** canvas is fixed at 78 columns regardless of terminal width.
On a 180-col terminal the star is a small island of cyan in a sea of empty space.

**Fix:** detect `process.stdout.columns` at render time. If ≥ 140, use W=120;
if ≥ 100, use W=96; else keep W=78. Scale R proportionally. All geometry
already parameterised — just pass different W/R to `renderStar`.

---

### 2c. `--star` and `--dual` show fleet stars when `--fleet=DIR` is also passed
**Problem today:** `--star` always shows corpus lifetime. `--dual` shows corpus
month + corpus lifetime. Neither shows the fleet.

**Fix:** when `--fleet=DIR` is also passed, `--star` shows all 4 stars stacked
vertically (corpus month / corpus lifetime / fleet month / fleet lifetime), each
labelled. `--dual` keeps its current 2-star layout but adds a fleet pair below.

---

## Phase 3 — Make it shareable (after Phase 2)

### 3a. GitHub Pages share target
**What:** a static page at `https://alexander-sorrell-it.github.io/starreckon/`
that reads URL params (`?star=27.0&arch=BUILDER&fp=5.4&en=5.3...`) and renders
the star as SVG in the browser. The QR in the terminal encodes this URL instead
of raw text, so scanning opens a real page on the phone.

**Why better than current:** scanning the QR today shows raw text. This shows
the star itself, the tier emblem, the archetype name, and the npx command.

**Implementation:**
- Single `docs/index.html` with inline SVG renderer (no build step, no deps)
- `sharePayload()` updated to build the URL instead of raw text when a base URL
  is configured (opt-in — raw text remains the default for privacy)

---

### 3b. Fleet sync over LAN (no shared folder)
**What:** machine B runs `starreckon broadcast` — it announces itself on the
LAN via mDNS (Bonjour/Avahi) and serves its machine folder. Machine A runs
`starreckon serve --discover` — it finds B automatically, pulls B's data,
merges it with its own, and serves the combined 4-star page.

**Why this matters:** today the fleet requires a shared directory (Dropbox,
USB, git repo). This makes it work with nothing but WiFi. Two people in the
same room can see a combined star with no setup.

**Implementation:** `src/discover.mjs` using mDNS. macOS: `dns-sd -R` /
`dns-sd -B`. Linux: `avahi-publish` / `avahi-browse`. Windows: `dns-sd.exe`
(Bonjour for Windows). Falls back to manual IP entry on unsupported platforms.

---

### 3c. npx publish — `npm publish`
**What:** bump version 0.13.1 → 0.14.0, run `npm pack --dry-run` to verify
the package contents, publish to npm.

**After this:** anyone can run `npx starreckon` with no install step.

**Needs:** npm token (starts `npm_...`) OR you run `npm publish` yourself.

**Pre-publish checklist:**
- `README.md` updated with new features (serve, contact, forge tiers, 4 stars)
- `package.json` version bumped
- `npm pack --dry-run` shows only the right files
- No secrets in any shipped file (`starreckon verify` passes)

---

## Phase 4 — deadreckon-count remaining work

### 4a. Fleet run on 5 unscanned machines
The 5 machines (dell-inspiron, hp-laptop, dell-latitude ×2, asus) have never
been scanned. Their contribution to the fleet floor is currently 0.

Each machine needs: `install.py --apply` + `run.py update` run once on it.
Requires physical access or SSH.

**After this:** the fleet floor (currently 49.1B from macbook-air-m1 alone)
grows to include all 6 machines.

### 4b. Definition of done
`retire_archive.py --yes` + `run.py rebuild` from zero = identical numbers.
This means the rebuild is deterministic and the gate is the authority.

---

## Summary — what to build in what order

```
Session 1 (now):
  Phase 1a — serve --scan (inline scan)
  Phase 1b — connection indicator
  Phase 1c — serve tests

Session 2:
  Phase 2a — arm-tip animation
  Phase 2b — wider star
  Phase 2c — fleet stars in --star/--dual

Session 3:
  Phase 3a — GitHub Pages share target
  Phase 3c — npx publish (needs npm token)

Session 4:
  Phase 3b — fleet LAN sync (mDNS discovery)

Ongoing:
  Phase 4a — scan remaining 5 machines (physical access needed)
```

---

## What is NOT in scope for starreckon

- Server-side percentile ranking — requires other users' data, structurally
  impossible while keeping zero outbound calls
- Cost estimates — rate tables go stale, same model bills differently through
  different routes, a stale number wearing a dollar sign is worse than nothing
- Transcript storage or cloud backup — starreckon reads, never archives


# Program Maps — starreckon + deadreckon
> Generated 2026-08-17. Source of truth for navigation. Update when functions move.

---

## starreckon
Path: `/media/phantomcore/AI_DRIVE/AI_Shit_mining/Quest coder/starforge-submission/starforge-repo/src/`

| File | Lines | Key functions |
|---|---|---|
| `cli.mjs` | 2,108 | `flag` `opt` `main` — entry point, all modes |
| `scan.mjs` | 1,037 | `parseClaudeFile` `parseCodexFile` `creditUsage` `discoverSources` `finalize` `computeStreaks` `claudeProfileDirs` |
| `scanners.mjs` | 1,341 | `readGemini` `readCopilot` `readGrok` `readKilo` `readAntigravity` `scanAllProviders` `scanPortedReaders` `providerOf` |
| `accounts.mjs` | 840 | `claudeGlobNames` `findConfigDirs` `scanProfile` `discoverAccounts` `floorTotals` `readStatsCache` |
| `profile.mjs` | 932 | `collectClaudeFile` `collectCodexFile` `computeProfile` `computeStreaks` `temporal` |
| `readers.mjs` | 721 | `readClaudeOrphans` `readClawspring` `readLmstudio` `readBob` `readCopilotChat` `readHistory` `coworkProfileDirs` |
| `fleet.mjs` | 881 | `readFleet` `writeMachineFolder` `machineFloor` `archiveSnapshots` `providerOf` |
| `snapshots.mjs` | 483 | `writeSnapshots` `loadTimeline` `lifetimeFromTimeline` `mergeMonth` `sameScanner` |
| `ledger.mjs` | 281 | `record` `lifetime` `rows` `cliMarker` |
| `protect.mjs` | 599 | `findClaudeProfiles` `linkTree` `allStores` `tick` `needsProtection` |
| `verify.mjs` | 1,433 | `outputScrub` `staticScan` `checkState` `verifyCli` `scrubWalk` |
| `sources.mjs` | 267 | `loadSources` `storePaths` `expandBase` `probe` `survey` `unknownStores` |
| `beacon.mjs` | 417 | `announceAndListen` `runLive` `buildAnnouncePayload` `signPacket` `verifyPacket` |
| `fleetkey.mjs` | 157 | `loadOrCreateFleetKey` `signPayload` `verifyPayload` `readPublicKeyBytes` |
| `fleetstar.mjs` | 152 | `fleetAggregates` `longestStreak` |
| `wrapped.mjs` | 1,074 | `buildCards` `buildCardsSafe` `renderAll` `sharePayload` `cardStar` `cardTokens` |
| `star.mjs` | 529 | `computeLevels` `renderStar` `LiveStar` `renderCompare` `explainLevels` |
| `statspage.mjs` | 595 | `renderStatsPage` |
| `card.mjs` | 211 | `renderCard` |
| `redact.mjs` | 289 | `redactSecrets` `maskPath` `accountPseudonym` `projectLabel` `maskIdentities` |
| `audit.mjs` | 646 | `verifyAuditChain` `startAudit` `finishAudit` `resetAudit` `armAuditExitHook` |
| `tripwire.mjs` | 144 | `armTripwire` `tripwireStatus` `patch` |
| `confine.mjs` | 337 | `detectConfinement` `buildProofCommand` `runConfined` `proveEgressBlocked` |
| `config.mjs` | 163 | `readConfig` `writeConfig` `effectiveRoots` |
| `discover.mjs` | 305 | `walk` `looksConversational` `sqliteTables` `summarise` |
| `daemon.mjs` | 284 | `writeSchedule` `removeSchedule` `daemonStatus` `describeSchedule` — installs launchd/systemd schedule |
| `shareurl.mjs` | — | `buildShareUrl` |
| `receipt.mjs` | — | `buildReceipt` `renderReceipt` |
| `serve.mjs` | — | `startServe` |
| `qr.mjs` | — | QR code generation |

### Known duplicates within starreckon
| Function | Lives in | Should live in |
|---|---|---|
| `computeStreaks` | `scan.mjs` + `profile.mjs` | `scan.mjs` only |
| `streamLines` | `scan.mjs` + `accounts.mjs` + `profile.mjs` | `scan.mjs` only |
| `temporal` | `scan.mjs` + `profile.mjs` | `scan.mjs` only |
| `providerOf` | `scanners.mjs` + `fleet.mjs` | `scanners.mjs` only |
| `findClaudeProfiles` | `protect.mjs` | should use `findConfigDirs` from `accounts.mjs` |
| `collectClaudeFile` | `profile.mjs` | should use `parseClaudeFile` from `scan.mjs` |
| `collectCodexFile` | `profile.mjs` | should use `parseCodexFile` from `scan.mjs` |

---

## deadreckon
Path: `/home/phantomcore/deadreckon-count/`

| File | Lines | Key functions |
|---|---|---|
| `sessions.py` | 2,817 | `read_claude` `read_codex` `read_gemini` `read_copilot` `read_bob` `read_lmstudio` `read_clawspring` `read_copilot_chat` `read_claude_orphans` `read_antigravity` `detect` `multi_base` `merge_session` |
| `analyze_tokens.py` | 1,080 | `find_config_dirs` `iter_usage` `scan` `MessageMax.credit` `account_for` `identity_for` |
| `check_consistency.py` | 2,408 | `published_gate` `published_claims` `chk` `main` — 62 checks |
| `retention_guard.py` | 1,891 | `link_tree` `claude_profiles` `run` `tick` `record_ledger` `_refuse` `_archive_holds` — **the daemon** |
| `sync_job.py` | 489 | `step_pull` `step_scan` `step_commit_own` `step_push` `step_combine` `step_health` `sync` — fleet sync |
| `adversarial_daemon.py` | 2,533 | 27 adversarial checks against `retention_guard` — credential leak, dead belt, already-archived, etc. |
| `export_corpus.py` | 1,990 | `export_tools` `walk_tree` `_is_loose_record` `_is_config` `_is_secret` |
| `stores.py` | 1,227 | `STORES` list (40+ entries), `Store` class, `state` `scan` `candidates` `tool_forms` |
| `monthly.py` | 904 | `collect` `fold_ledger` `fold_ledger_fleet` `apply_statscache_floor` `render` |
| `run.py` | 957 | `rebuild` `status` `foreign_staged` `this_machine` `reset` |
| `token_ledger.py` | 398 | `observe` `lifetime` `record` `cli_marker` |
| `platform_detect.py` | 503 | `detect` `family` `real_home` `probe` |
| `paths.py` | 260 | `machine_folders` `this_machine_folder` `human` `machine` |
| `update.py` | 359 | `run` `snap` `archive` |
| `stats.py` | 194 | `load` `streaks` |
| `conformance/run_deadreckon.py` | — | conformance oracle runner |

### Lifetime chain
```
transcript on disk
  → daemon tick() → linkTree() archives it (hard link)
                  → record_ledger() writes to token_ledger.jsonl
transcript deleted by cleanupPeriodDays
  → ledger still has it → lifetime() reads it back
  → .claude.json counters still have it → readClaudeOrphans() reads them
  → hard-link archive still has it → can re-scan if needed

starreckon: same chain via protect.mjs tick() + ledger.mjs record/lifetime
deadreckon: retention_guard.py tick() + token_ledger.py lifetime()
```

---

## Shared contract
- `spec/sources.json` — every AI tool source, store paths, which programs count it. **Identical in both repos.**
- `tests/conformance/` + `deadreckon-count/conformance/` — shared oracle fixture. Both programs must match it.

## Parity gaps (open)
| Gap | deadreckon | starreckon |
|---|---|---|
| Codex arithmetic | `last_token_usage` (per-turn delta) | `total_token_usage` (running total) — agree on live data, diverge on edge cases |
| Cowork | no reader (`no_reader`) | `scan.mjs` reads it fully |
| KNOWN_CLI_NAMES vs READERS | 8 names in `config.mjs` | 5 keys in `scanners.mjs` — overlap on 3 |

## Current test status
- deadreckon: `check_consistency` 62/0 · conformance 47/0 · readers 305/0 · scanner 91/0 · fleet 182/0 · fleet merge 34/0 · gate 16/0
- starreckon: `npm test` 683/0 · 9 skip (OS confinement — Linux/macOS only)

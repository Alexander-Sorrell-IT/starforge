# CLI Session Store Locations

Where every supported CLI keeps its session files, what environment variables
move them, and whether an API key fills in anything the local scan cannot read.

starreckon protects all of these with `starreckon protect` (or the 6-hour
daemon job): it raises Claude's `cleanupPeriodDays` so transcripts are not
auto-deleted, and hard-links every file below into `~/.ai-logs-archive/<store>/`
so that even a manual deletion cannot erase the ledger record.

---

## Claude Code

| Item | Value |
|------|-------|
| Sessions | `~/.claude/projects/**/*.jsonl` |
| Stats cache (lifetime counter) | `~/.claude/stats-cache.json` |
| Profile settings | `~/.claude/settings.json` |
| Alternate profile dirs | `~/.my-claude*/`, `~/.proteus*/` (same shape) |
| Auto-delete | Yes — `cleanupPeriodDays` (default 30). `protect` raises it to 36500. |
| API key coverage | Account email not needed — read from `.claude.json` OAuth token on disk |

**Env vars that move the store:**
- `CLAUDE_CONFIG_DIR` — relocates the entire `~/.claude/` tree

---

## Codex

| Item | Value |
|------|-------|
| Sessions | `~/.codex/sessions/*.json` |
| Archived sessions | `~/.codex/archived_sessions/*.json` |
| Auto-delete | No known auto-delete |
| Counting trap | Cumulative emission (40.7× if naively summed) — starreckon deduplicates by `session_id` |

**Env vars:**
- `CODEX_HOME` — relocates `~/.codex/`

---

## Gemini CLI

| Item | Value |
|------|-------|
| Sessions | `~/.gemini/tmp/**/*.json` |
| Auto-delete | No known auto-delete |
| Counting trap | `cached` field is a subset of `input_tokens`, not additive (83% inflation if added) |

**Env vars:**
- `GEMINI_CONFIG_DIR` — may relocate the store

---

## GitHub Copilot (CLI / Chat)

| Item | Value |
|------|-------|
| Sessions | `~/.copilot/session-state/**/*.json` |
| VS Code workspace storage | `~/Library/Application Support/Code/User/workspaceStorage/` (macOS) |
| Auto-delete | No known auto-delete |
| Counting trap | 2.9× bookkeeping inflation if raw totals summed — starreckon uses per-session dedup |

---

## Grok

| Item | Value |
|------|-------|
| Sessions | `~/.grok/sessions/*.json` |
| Archived sessions | `~/.grok/archived_sessions/*.json` |
| Auto-delete | No known auto-delete |

---

## Cursor

| Item | Value |
|------|-------|
| Chat history | `~/.cursor/chats/` |
| Auto-delete | No known auto-delete |

---

## Aider

| Item | Value |
|------|-------|
| Session files | `~/.aider/` |
| Auto-delete | No known auto-delete |

---

## Continue

| Item | Value |
|------|-------|
| Sessions | `~/.continue/sessions/` |
| Auto-delete | No known auto-delete |

**Env vars:**
- `CONTINUE_GLOBAL_DIR` — may relocate the store

---

## OpenCode

| Item | Value |
|------|-------|
| Sessions | `~/.opencode/sessions/` |
| Auto-delete | No known auto-delete |

---

## Goose

| Item | Value |
|------|-------|
| Sessions | `~/.config/goose/sessions/` |
| Auto-delete | No known auto-delete |

---

## OpenHands

| Item | Value |
|------|-------|
| Sessions | `~/.openhands/sessions/` |
| Auto-delete | No known auto-delete |

---

## Qwen (Qwen-Agent CLI)

| Item | Value |
|------|-------|
| Sessions | `~/.qwen/tmp/` |
| Auto-delete | No known auto-delete |

---

## Amp

| Item | Value |
|------|-------|
| Threads | `~/.amp/threads/` |
| Auto-delete | No known auto-delete |

---

## DeepSeek

| Item | Value |
|------|-------|
| Sessions | `~/.deepseek/sessions/` |
| Auto-delete | No known auto-delete |

---

## LM Studio

| Item | Value |
|------|-------|
| Conversations | `~/.lmstudio/conversations/` |
| Auto-delete | No known auto-delete |

---

## Antigravity (Gemini variant)

| Item | Value |
|------|-------|
| Conversations | `~/.gemini/antigravity-cli/conversations/` |
| Auto-delete | No known auto-delete |

---

## Ollama

| Item | Value |
|------|-------|
| History | `~/.ollama/history` (single file) |
| Auto-delete | No known auto-delete |

**Env vars:**
- `OLLAMA_HOME` — relocates `~/.ollama/`

---

## Bob (this tool's own session store)

| Item | Value |
|------|-------|
| Database | `~/.bob/db/` |
| Auto-delete | No known auto-delete |

---

## VS Code extensions (Kilo Code, Cline, Roo Code)

These three extensions store tasks under VS Code's `globalStorage` directory.
The exact path varies by OS and VS Code variant:

| OS | Base |
|----|------|
| macOS | `~/Library/Application Support/<variant>/User/globalStorage/` |
| Linux | `~/.config/<variant>/User/globalStorage/` |

`<variant>` is one of: `Code`, `Code - Insiders`, `VSCodium`, `Code - OSS`

| Extension | Extension ID | Subdirectory |
|-----------|-------------|--------------|
| Kilo Code | `kilocode.kilo-code` | `tasks/` |
| Cline | `saoudrizwan.claude-dev` | `tasks/` |
| Roo Code | `rooveterinaryinc.roo-cline` | `tasks/` |

**Env vars:**
- `VSCODE_APPDATA` / `XDG_CONFIG_HOME` — may relocate the VS Code config root

---

## API key coverage

API keys are **additive only** — the local file scan always runs regardless.
A key fills in what local files cannot answer (e.g. which org owns a key-only
profile with no OAuth email on disk). Configure them in `~/.starreckon/config.json`:

```json
{
  "api_keys": {
    "claude": "sk-ant-...",
    "gemini": "AIza...",
    "copilot": "gho_..."
  }
}
```

Supported CLI names: `claude`, `gemini`, `copilot`, `codex`, `grok`,
`kilocode`, `lmstudio`, `antigravity`

---

## Extra roots

If session files live outside the default home (second account, external drive,
or a directory pointed to by an env var above), add them to
`~/.starreckon/config.json`:

```json
{
  "extra_roots": ["/Volumes/OldDrive/Users/me", "/home/work"]
}
```

This is the persisted equivalent of `--roots=a,b` on the command line.
Standard locations (everything under `~` at depth ≤ 4) are found automatically.

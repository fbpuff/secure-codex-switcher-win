## Why

The Windows desktop application is now branded and launched as ChatGPT Codex (`ChatGPT.exe`), while Secure Codex Switcher still recognizes only the older `Codex.exe` process name. During a switch, the updated application also fails to start when two locally installed plugins expose outdated manifest or MCP behavior.

## What Changes

- Treat the Microsoft Store ChatGPT Codex desktop session (`ChatGPT.exe`) and its internal `codex.exe` app-server as one official application session for process counting and safe shutdown.
- Launch the current ChatGPT Codex application identity after a switch and use ChatGPT Codex in user-facing lifecycle text, while retaining `.codex` only for compatibility paths and technical storage names.
- Add a local, repeatable recovery script for the two observed plugin startup blockers: the overlong `ngs-analysis` prompt and the missing `resources/list` response in the bundled Sites MCP server.
- Document the terminology boundary, recovery scope, backups, and privacy exclusions.

## Capabilities

### New Capabilities

- `chatgpt-codex-session-lifecycle`: Identifies, closes, and relaunches the current ChatGPT Codex desktop session during account switching.
- `chatgpt-codex-plugin-recovery`: Repairs only the verified local plugin compatibility defects with backups and without accessing account credentials.

### Modified Capabilities

None. This repository has no base OpenSpec capability specifications.

## Impact

- `src/core/official-codex-process.js` and `src/services/account-service.js` process lifecycle behavior.
- User-facing lifecycle text in the renderer and documentation.
- New tests for the ChatGPT Codex executable identity.
- One local PowerShell recovery script that operates outside the repository only when explicitly run.

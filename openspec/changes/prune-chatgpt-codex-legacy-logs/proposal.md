## Why

ChatGPT Codex local diagnostic logs from June 2026 consume about 1.81 GB. They are not required for application startup, account switching, authentication, sessions, plugins, or current July diagnostics.

## What Changes

- Remove only `%LOCALAPPDATA%\Codex\Logs\2026\06` after confirming the exact resolved path and its sibling July log directory.
- Record the cleanup scope, verification result, and privacy boundary in the local project OpenSpec change.

## Capabilities

### New Capabilities

- `chatgpt-codex-log-retention`: Defines the safe retention boundary for dated local ChatGPT Codex diagnostic logs.

### Modified Capabilities

None.

## Impact

- Frees local disk space by deleting only historic diagnostic log files.
- Removes the ability to inspect June 2026 ChatGPT Codex diagnostic history.
- Does not change application code, account data, auth state, plugins, sessions, or current logs.

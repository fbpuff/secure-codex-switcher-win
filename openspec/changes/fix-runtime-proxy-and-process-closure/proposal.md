# Fix Runtime Proxy And Process Closure

## Why

Desktop-shortcut startup bypasses the launcher proxy import, so all usage refreshes time out on networks that require the configured Windows user proxy. Process-tree traversal can also loop forever on cyclic or PID-reused parent records, causing ChatGPT Codex closure to hit its ten-second timeout before switching.

## What Changes

- Resolve proxy settings inside the packaged application, with explicit environment variables taking precedence over the enabled Windows user proxy.
- Report actionable proxy/connectivity failures without exposing endpoint credentials or Electron IPC wrapper text.
- Add cycle protection to every process-tree traversal.
- Recognize the current packaged ChatGPT Codex host process family while preserving the active caller-tree exclusion.
- Verify direct desktop startup, bounded process counting, account switching, and safe failure behavior.

## Privacy

Only proxy host/port and process metadata are inspected locally. Credentials, account records, tokens, sessions, request headers, and report data are never logged or committed.

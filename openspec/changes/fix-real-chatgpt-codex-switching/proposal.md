# Fix Real ChatGPT Codex Switching

## Why

When Secure Codex Switcher is launched from ChatGPT Codex, its current process becomes a descendant of `ChatGPT.exe`. The generated close script currently excludes the invoking process's entire official ancestor tree, so it excludes every running ChatGPT Codex process. The Switcher then writes a new auth file while the old desktop process remains alive, producing a misleading zero-close success and an apparent switch that is not live.

## What Changes

- Stop excluding an official ancestor tree for normal Switcher count and close operations; only exclude the Switcher process itself, which is not an official Codex process.
- Before writing auth, verify that no official ChatGPT Codex processes remain after the close operation.
- Fail closed when a running official process cannot be closed, preserving the previous auth file and reporting a clear reason.
- Return switch outcome evidence needed to distinguish an actual restart from an unchanged running application.
- Cover launch-from-ChatGPT, no-running-process, close-failure, and process-tree cycle cases.

## Privacy

The fix uses local process metadata and existing encrypted auth storage only. It does not log, expose, or commit tokens, account IDs, auth contents, sessions, or conversation data.

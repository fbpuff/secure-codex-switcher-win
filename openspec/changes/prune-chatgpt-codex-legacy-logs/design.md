## Context

The active ChatGPT Codex desktop application writes diagnostics under `AppData\Local\Codex\Logs`. The current directory contains June and July 2026 logs. Only the June subtree is in scope; the current July subtree and every non-log data directory are excluded.

## Goals / Non-Goals

**Goals:**

- Delete the resolved June 2026 diagnostic-log subtree only after verifying its absolute path and size.
- Verify that the July log directory remains present afterward.
- Preserve the cleanup record in local Git without adding any log content.

**Non-Goals:**

- Deleting `.codex`, roaming profile data, local runtime files, plugin caches, account stores, auth files, or sessions.
- Cleaning current July logs or uninstalling any ChatGPT Codex package.

## Decisions

Use a direct, absolute path scoped to `Logs\2026\06`. This is narrower and safer than deleting by extension, date search, or the whole log root.

## Risks / Trade-offs

- [Risk] June diagnostic evidence is no longer available. -> Mitigation: retain current July diagnostics and record the deleted scope and byte count in the OpenSpec task.
- [Risk] Cleanup could target a wrong directory. -> Mitigation: verify the resolved absolute target and direct parent before removal, then verify July remains after removal.

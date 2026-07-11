## Why

Secure Codex Switcher can import, rank, and switch accounts, but the automatic switching path is still too UI-memory-driven for daily use: queued switches are not durable, activity detection can be blocked by stale PID records, and the user cannot choose a preferred next account. The product should make the user's switching intent explicit, preserve that intent across refreshes/restarts, and explain why a switch did or did not happen.

## What Changes

- Add an optional next-account selection mode: use the highest-scored usable account by default, or let the user choose a specific next switch target.
- Make account ordering respect user intent: current account first, manually selected next account second when set, then the remaining accounts by score.
- Move auto-switch decision state out of renderer-only memory into local persisted app state so queued switches survive window reloads and app restarts.
- Harden Codex activity detection so stale or reused PIDs do not permanently block an eligible queued switch.
- Add user-facing status and local diagnostic history for auto-switch decisions, including target selection, waiting reason, unavailable-target reason, and last switch result.
- Keep all runtime state local and avoid storing raw auth tokens, API keys, conversation text, or private Codex session content in diagnostics.

## Capabilities

### New Capabilities
- `switch-target-selection`: Covers default scored target selection, optional manual next-account selection, account ordering, and behavior when a selected target is unavailable.
- `reliable-auto-switch`: Covers durable queued auto-switch state, activity-aware waiting, target revalidation, and safe switch execution.
- `switch-diagnostics`: Covers visible status and local diagnostic history for why switching is waiting, skipped, failed, or complete.

### Modified Capabilities

None. This repository has no existing OpenSpec specs yet.

## Impact

- Renderer UI: account list ordering, settings/detail controls, status text, and quota warning display.
- Main/preload IPC: new methods for switch preference and auto-switch state/diagnostics.
- Account service: settings normalization, persisted switch state, target resolution, activity detection validation, and diagnostics writing.
- Tests: ranking/target selection, settings migration, activity PID validation, durable queue behavior, and renderer-facing IPC expectations.
- Documentation: README updates for manual target mode, reliable auto-switch behavior, diagnostics privacy, and troubleshooting.

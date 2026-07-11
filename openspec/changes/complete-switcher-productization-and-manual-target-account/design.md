## Context

The current app is a local Windows Electron application with a Node main process, a preload IPC facade, a plain JavaScript renderer, and an `AccountService` that owns encrypted account storage, settings, usage refresh, ranking, and switch execution. Automatic switching is currently coordinated mostly by renderer memory: when the current account is exhausted, the renderer picks a target, stores `pendingAutoSwitch` in memory, and polls activity every 15 seconds.

That shape causes three product issues:

- The user cannot express "use this account next" except by manually switching.
- A queued switch can be lost when the renderer reloads or the app restarts.
- Activity detection trusts stale `chat_processes.json` PIDs, so PID reuse can make unrelated processes look like active Codex work.

The app should remain local-only, dependency-light, and compatible with the existing DPAPI account store and settings file.

## Goals / Non-Goals

**Goals:**

- Add a clear target-selection mode: automatic best-score target by default, optional manual next-account target when the user chooses one.
- Keep the current account first in account lists, place the manual target second when configured, and sort the remaining accounts by score.
- Persist pending auto-switch state and recent switch diagnostics in app user data.
- Move auto-switch target resolution and queued-state mutation into `AccountService` so the main process owns durable switching state.
- Validate activity PIDs against actual Codex process identity before treating them as blocking active work.
- Provide bilingual UI text and README coverage for the new behavior.

**Non-Goals:**

- Replacing Electron, adding a separate background Windows service, or merging with another product.
- Changing DPAPI account encryption or storing raw auth JSON in diagnostics.
- Adding remote telemetry, OpenSpec stores, or external diagnostics.
- Replacing the existing usage endpoint or scoring formula.

## Decisions

### Decision 1: Store target preference in settings

Add two normalized settings:

- `autoSwitchTargetMode`: `"best"` or `"manual"`
- `manualAutoSwitchTargetAccountId`: account id string or `undefined`

Rationale: the preference is user configuration, not a transient queue. Keeping it in `settings.json` lets it survive restarts without touching encrypted account records.

Alternative considered: store the preferred target on the account object. Rejected because the preference is global behavior and deleting/reimporting accounts would make cleanup less obvious.

### Decision 2: Store queued auto-switch state separately from settings

Add a local JSON state file such as `auto-switch-state.json` under Electron userData. It contains only operational state:

- pending target account id and masked label
- queue creation/update timestamps
- last busy reason and quiet-until timestamp
- last terminal status

Rationale: queue state is not user configuration and should be cleared or replaced independently. It also allows UI reloads to recover a pending decision.

Alternative considered: keep queue state in renderer `localStorage`. Rejected because switching is a privileged main-process operation and renderer state is easier to desynchronize.

### Decision 3: AccountService owns target resolution and queue transitions

Introduce service methods behind IPC:

- read/update auto-switch target preference
- evaluate auto-switch after usage refresh or settings changes
- read pending auto-switch state
- clear pending auto-switch state
- read recent switch diagnostics

The renderer will still render state and call the service after refresh flows, but it will not be the source of truth for pending queue mutation.

Rationale: this is the smallest change that makes state durable without introducing a separate daemon or scheduler. It also keeps switch execution next to account storage, settings, process closing, and Codex launch logic.

Alternative considered: run an independent always-on background service. Rejected for this change because it adds installation and lifecycle complexity; the app already remains active in tray.

### Decision 4: Activity detection must verify process identity

Update `countActiveChatProcesses` so a PID from `chat_processes.json` only blocks switching when the current OS process still looks like official Codex. On Windows this should use the same executable-path rules already used by `officialCodexProcessScript`, exposed through a small reusable helper or injectable process-inspection seam for tests.

Rationale: PID existence alone is not enough on Windows. PID reuse can otherwise block queued switching forever.

Alternative considered: ignore `chat_processes.json` entirely and use only recent rollout mtime. Rejected because active chat processes are still the most direct signal when valid.

### Decision 5: Diagnostics are explicit and redacted

Write a bounded local JSONL diagnostic log, such as `auto-switch-events.jsonl`, with event type, timestamps, masked account label, target mode, reason, and non-sensitive details. Do not include raw auth JSON, access tokens, refresh tokens, API keys, conversation text, or full session contents.

Rationale: users need to know why switching did not happen, and future debugging should not require reading private runtime files.

Alternative considered: only show transient UI status. Rejected because the main failure mode is retrospective: "it did not switch earlier; why?"

## Risks / Trade-offs

- [Risk] Persisted target account id can point to a deleted account. -> Mitigation: target resolution treats deleted or unavailable manual targets as invalid and reports the reason without silently switching to a different account unless mode is `"best"`.
- [Risk] Moving queue logic into the service can duplicate some renderer checks during migration. -> Mitigation: first add service methods and tests, then remove renderer-owned queue mutation in a focused step.
- [Risk] Process identity checks may differ between packaged Codex paths. -> Mitigation: reuse the existing official Codex process-path rules and add tests for known accepted paths plus PID-reuse rejection.
- [Risk] Diagnostics can grow over time. -> Mitigation: keep a small rolling history or prune to a fixed maximum event count/size.

## Migration Plan

1. Existing `settings.json` files normalize to `autoSwitchTargetMode: "best"` and no manual target.
2. Existing users keep current behavior until they choose manual mode.
3. Existing renderer queue state is not migrated because it is already transient.
4. New state and diagnostic files are created lazily and can be deleted to reset auto-switch runtime state.
5. Rollback is safe: older versions will ignore unknown settings fields and will not read the new state/log files.

## Open Questions

- Whether the UI should expose manual target mode in the account detail panel, the settings page, or both. The implementation should prefer the smallest discoverable surface: an account action plus a settings summary.
- Whether diagnostics should show only the latest event in the top bar or include a small "recent decisions" panel. Initial implementation can expose the latest decision in status text and keep the event file for support/debugging.

## 1. Target Preference Model

- [x] 1.1 Extend settings normalization with `autoSwitchTargetMode` and `manualAutoSwitchTargetAccountId`, defaulting to best-score mode.
- [x] 1.2 Add AccountService APIs and IPC/preload methods to read, update, and clear the manual auto-switch target preference.
- [x] 1.3 Update account listing order so current account is first, valid manual target is second, and remaining accounts are score-sorted.
- [x] 1.4 Add tests for settings migration, manual target persistence, deleted-target cleanup behavior, and list ordering.

## 2. Reliable Auto-Switch State

- [x] 2.1 Add a local `auto-switch-state.json` service layer with normalized read/write/clear helpers.
- [x] 2.2 Move target resolution into AccountService so best-score and manual-target modes are handled by one tested path.
- [x] 2.3 Add service methods to evaluate auto-switch eligibility, persist queued state, revalidate pending state, and execute when activity is idle.
- [x] 2.4 Replace renderer-owned `pendingAutoSwitch` mutation with calls to the service-owned queue state while keeping UI rendering reactive.
- [x] 2.5 Add tests for queued state persistence, current-account recovery cancellation, manual target unavailable behavior, and best-score fallback behavior.

## 3. Activity Detection Hardening

- [x] 3.1 Extract or reuse official Codex process identity checks so activity detection can validate live PID name/path, not only PID existence.
- [x] 3.2 Add an injectable process-inspection seam for `getCodexActivityStatus` tests.
- [x] 3.3 Update `countActiveChatProcesses` to ignore stale or reused PIDs that no longer match official Codex identity rules.
- [x] 3.4 Add tests proving reused non-Codex PIDs do not block switching and official Codex PIDs still count as busy.

## 4. Diagnostics And UI

- [x] 4.1 Add a bounded local `auto-switch-events.jsonl` diagnostic writer with redaction and pruning.
- [x] 4.2 Record diagnostic events for target selection, waiting, cancellation, unavailable target, switch failure, and successful switch.
- [x] 4.3 Add UI controls for manual target mode: an account action to set/clear the next target and a settings/status summary.
- [x] 4.4 Add bilingual UI strings for target mode, queued state, unavailable manual target, diagnostics, and cleared target.
- [x] 4.5 Ensure diagnostics and UI never display raw auth JSON, access tokens, refresh tokens, API keys, bearer tokens, or conversation text.

## 5. Documentation And Verification

- [x] 5.1 Update README and README.zh-CN with manual target mode, best-score default behavior, durable queue semantics, PID validation, and diagnostics privacy.
- [x] 5.2 Run `npm test`.
- [x] 5.3 Run syntax checks for changed JavaScript entry points.
- [x] 5.4 Run `openspec validate complete-switcher-productization-and-manual-target-account --strict` and fix any spec issues.
- [x] 5.5 Inspect `git status --short --ignored` and run a scoped secret scan before staging or committing.

## 6. Detail UI And Local Runtime Completion

- [x] 6.1 Move the manual next auto-switch target control above the quota/usage section so it reads as switching policy, not a destructive/action command.
- [x] 6.2 Rebalance the account detail UI proportions for network mode and action controls, keeping buttons compact and aligned at narrow widths.
- [x] 6.3 Remove duplicate Codex Switcher instances while preserving one running latest app instance.
- [x] 6.4 Complete the local runtime so the launcher can use the repository's `node_modules\electron\dist\electron.exe` without relying on an old workspace.
- [x] 6.5 Re-run syntax checks, OpenSpec validation, status/privacy inspection, restart the latest app, and commit the launcher/UI changes.

## 7. Merged Detail Controls

- [x] 7.1 Merge the account detail `Network mode` and `Actions` sections into one coordinated control section.
- [x] 7.2 Keep manual switch, refresh, delete, and per-account HTTP-only controls visually balanced at desktop, compact, and narrow widths.
- [x] 7.3 Re-run syntax checks, OpenSpec validation, status/privacy inspection, restart the latest app, and commit the merged-control UI change.

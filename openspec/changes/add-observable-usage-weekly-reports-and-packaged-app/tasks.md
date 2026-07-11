## 1. Scope And Evidence

- [x] 1.1 Confirm the current quota endpoints, snapshot fields, refresh interval, local `last_token_usage` parser, navigation structure, score-popover implementation, launcher, and development Electron process identity.
- [x] 1.2 Document the distinction between server quota snapshots, real local rollout-token counters, and non-official observed capacity estimates.
- [x] 1.3 Inspect representative current rollout metadata shapes without reading conversation bodies and determine which model, reasoning-effort, timing, and session identifiers are reliably available.
- [x] 1.4 Define supported Windows widths, report retention period, week boundary/timezone, rounding-noise threshold, and minimum sample requirements from measured local data.
- [x] 1.5 Revalidate this OpenSpec change strictly after evidence-driven design values are finalized.

## 2. Test-First Observation Model

- [x] 2.1 Add failing synthetic tests for idempotent cumulative-token delta extraction, model/reasoning metadata parsing, unknown metadata, log truncation, and appended-event rescans.
- [x] 2.2 Add failing tests for active-account intervals covering imports, switches, startup uncertainty, external login changes, overlap, gaps, and redacted persisted identifiers.
- [x] 2.3 Add failing tests for quota-snapshot history, source timestamps, same-window validation, reset crossing, percentage rounding, external-use evidence, and invalid-sample rejection.
- [x] 2.3a Add failing tests for scheduled resets, observed unscheduled resets, consecutive-snapshot confirmation, account mismatch rejection, and explicit-only reset-card labeling.
- [x] 2.4 Add failing tests for token rate, quota percentage-point rate, observed capacity range, confidence classification, grouped mean/median, and sample counts.

## 3. Local Observation Storage And Privacy

- [x] 3.1 Define a versioned local observation schema for account intervals, quota snapshots, token deltas, metadata dimensions, confidence evidence, and weekly aggregates.
- [x] 3.2 Implement atomic writes, corruption recovery, bounded retention, pruning, and idempotent migration without storing credentials or conversation text.
- [x] 3.3 Extend `.gitignore`, redaction checks, diagnostics, and synthetic fixtures so observation/report data, masked-account mappings, and generated reports cannot enter Git.
- [x] 3.4 Add a local reset/delete control for observation and weekly-report history with explicit confirmation and no effect on encrypted account records or Codex sessions.

## 4. Account, Model, And Reasoning Attribution

- [x] 4.1 Record active-account interval evidence during startup reconciliation, import, manual switch, automatic switch, login-new flow, and deletion/replacement flow.
- [x] 4.2 Parse only approved non-content rollout fields for model, reasoning effort, timestamps, duration, and token counters; preserve `unknown` when evidence is absent.
- [x] 4.3 Attribute token deltas only to unambiguous account intervals and keep ambiguous or external-use intervals in a separate unattributed bucket.
- [x] 4.4 Compute per-account/model/reasoning token totals, input/cached/output/reasoning breakdowns, event counts, active time, wall-clock time, and both labeled rate types.

## 5. Quota Freshness And Capacity Observation

- [x] 5.1 Persist redacted 5h/7d quota snapshots with source endpoint class, fetched time, reset time, account reference, refresh result, and stale/error state.
- [x] 5.2 Show quota source, last successful refresh time, snapshot age, refreshing state, and stale/error status in account detail without implying real-time synchronization with ChatGPT Codex.
- [x] 5.3 Add mismatch diagnostics that distinguish stale snapshot, different account, refresh failure, reset boundary, rounding, and unavailable upstream fields.
- [x] 5.3a Detect scheduled and observed-unscheduled 5h/7d resets, close the prior observation window, and label a reset card only when the upstream payload provides explicit evidence.
- [x] 5.3b Exclude every reset-spanning interval from quota rate and capacity estimation while preserving pre-reset and post-reset observations separately.
- [x] 5.4 Calculate observed 5h/7d capacity samples only from valid same-account/same-window intervals and expose range, median, mean, sample count, and confidence.
- [x] 5.5 Clearly label all capacity results as local observations rather than official or fixed OpenAI token limits.

## 6. Weekly Reports View

- [x] 6.1 Add a `报告 / Reports` navigation item between `用量 / Usage` and `设置 / Settings`, with its own view, route state, icon, bilingual labels, loading, empty, error, and privacy states.
- [x] 6.2 Default to the latest complete local week and add retained-week selection plus account, model, reasoning-effort, and confidence filters.
- [x] 6.3 Show per-account 5h/7d observations, local token totals, token composition, active duration, token rate, quota rate, capacity range, confidence, and unattributed usage.
- [x] 6.4 Show grouped model/reasoning comparisons, account-level and grouped averages, medians, ranges, sample counts, and flagged anomalies without mixing plan types blindly.
- [x] 6.5 Add concise explanations for local-token coverage, cross-device limitations, capacity-estimate formula, confidence levels, and why values can differ from ChatGPT Codex.
- [x] 6.5a Show scheduled and observed-unscheduled reset events in weekly history with reason unknown unless explicit upstream evidence identifies a reset card or another cause.
- [x] 6.6 Add weekly history retention and deterministic regeneration from retained observation data; do not add automatic upload, email, or remote synchronization.

## 7. Responsive Score Explanation Fix

- [x] 7.1 Add failing renderer/browser tests reproducing right-edge clipping at the reported narrow window and pane proportions in Chinese and English.
- [x] 7.2 Implement viewport-aware left/right placement and horizontal clamping while preserving hover, focus, click/touch pinning, Escape, and outside-click dismissal.
- [x] 7.3 Use a single-column breakdown when required and verify the formula, rules, account label, and all four values remain fully visible without horizontal overflow.

## 8. Packaged Windows Product Identity

- [x] 8.1 Compare the existing Electron version and dependencies against the smallest suitable Windows packaging path; record the selected tool and artifact layout before adding a dependency.
- [x] 8.2 Add product name, executable name `Secure Codex Switcher`, application user model ID, version metadata, icon assets, package scripts, and ignored build outputs.
- [x] 8.3 Build a packaged Windows artifact and verify Task Manager, window identity, executable properties, tray icon, single-instance behavior, DPAPI access, account-data location, and ChatGPT Codex restart flows.
- [x] 8.4 Update `Start-CodexSwitcher.ps1` and desktop shortcut handling to launch the packaged executable by default while retaining an explicit documented development command.
- [x] 8.5 Verify upgrades preserve local encrypted accounts, settings, observations, reports, and backups without copying any of them into the package.

## 9. Verification And Delivery

- [x] 9.1 Run targeted tests, the full suite, JavaScript syntax checks, strict OpenSpec validation, and deterministic weekly-report fixtures.
- [x] 9.2 Perform real Electron visual checks at supported normal/narrow widths in Chinese, English, light, and dark themes; verify no clipping, overlap, blank charts, or layout shifts.
- [x] 9.3 Run privacy scans across source, fixtures, staged files, package contents, and generated report storage; confirm no credential, raw account data, conversation text, session, log, backup, or cache is committed or packaged.
- [x] 9.4 Update English and Chinese documentation with data provenance, formulas, confidence limits, report navigation, retention controls, and packaged launch behavior.
- [x] 9.5 Commit implementation in reviewable local Git commits, restart the packaged Secure Codex Switcher, and verify one latest product-named main process.

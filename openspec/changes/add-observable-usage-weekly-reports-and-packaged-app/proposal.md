## Why

The app currently shows server quota snapshots and local rollout-token totals close together, but the two data sources have different refresh timing and coverage. Users cannot see the snapshot age, cannot reliably attribute local tokens to an account, model, or reasoning effort, and cannot compare observed quota consumption over a week. The score-help popover is also clipped in narrower window layouts. Finally, the app is launched through the development `electron.exe`, so Windows Task Manager identifies the process as Electron instead of Secure Codex Switcher.

## What Changes

- Make server quota provenance, freshness, and refresh timing visible without presenting snapshots as real-time billing data.
- Define a privacy-preserving local observation timeline that attributes token events to the account active during an interval and records model, reasoning effort, duration, and data-confidence evidence when available.
- Estimate observed 5-hour and 7-day token-capacity ranges from quota deltas and attributable local token deltas, explicitly distinguishing estimates from official limits.
- Add a dedicated weekly Reports view between Usage and Settings with per-account, model, reasoning-effort, rate, confidence, average, and median summaries.
- Fix the score-help popover so formulas and all four values remain visible at supported window widths and pane proportions.
- Package and launch the app as `Secure Codex Switcher.exe` with product metadata and icon so Windows surfaces use the product identity instead of `electron.exe`.

## Capabilities

### New Capabilities

- `quota-observability`: Defines quota source, age, refresh-state, and mismatch diagnostics.
- `account-attributed-usage-observation`: Defines local account/model/reasoning attribution, rates, capacity estimates, and confidence boundaries.
- `weekly-usage-reports`: Defines the dedicated Reports navigation, weekly aggregation, grouping, history, and explanatory UI.
- `packaged-windows-product-identity`: Defines production packaging and Windows process/product identity.

### Modified Capabilities

- `best-account-score-explanation`: Requires boundary-aware placement and narrow-layout rendering for the existing score-help popover.

## Impact

- Local usage/quota observation storage, migration, retention, and privacy redaction.
- Rollout parsing, account switch timeline, quota refresh pipeline, aggregation tests, IPC, preload, renderer navigation, and bilingual UI.
- Packaging scripts, product metadata, launcher behavior, icon assets, and release documentation.
- No claim that observed capacity is an official or fixed OpenAI token limit.
- No conversation body, raw credential, auth token, API key, or unmasked account identifier may enter reports, diagnostics, or Git.

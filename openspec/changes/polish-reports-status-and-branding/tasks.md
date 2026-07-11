## 1. Tests And Specification

- [x] 1.1 Add regressions for shared chart baselines, compact quota evidence, and centered disclosure icons.
- [x] 1.2 Add account-state and mixed usable/unavailable ordering tests.
- [x] 1.3 Add report cache, stale refresh, manual refresh, and visible timestamp tests.
- [x] 1.4 Strictly validate the OpenSpec change.

## 2. Usage And Report UI

- [x] 2.1 Align both seven-day panels with identical row and value geometry.
- [x] 2.2 Rename quota consumption to observed quota changes and add concise bilingual help.
- [x] 2.3 Compact account rows and remove awkward wrapping and excess row height.
- [x] 2.4 Replace model text arrows with centered CSS chevrons.

## 3. Account Status And Branding

- [x] 3.1 Replace the single score presentation with immediate state, overall remaining quota, and expected recovery.
- [x] 3.2 Sort usable accounts by quota and blocked accounts by recovery without treating 7d remaining as immediately usable when 5h is exhausted.
- [x] 3.3 Replace the internal `CS` brand mark with the switch icon treatment.

## 4. Report Refresh Experience

- [x] 4.1 Cache reports by mode and selected date and render cached results immediately.
- [x] 4.2 Refresh stale reports in the background using the configured refresh interval.
- [x] 4.3 Keep existing report content visible while refreshing and show last-updated/loading state.

## 5. Verification And Delivery

- [x] 5.1 Run focused/full tests, syntax checks, strict validation, audit, and diff checks.
- [x] 5.2 Build and inspect screenshots for usage, report, model, account status, and branding views.
- [x] 5.3 Bump version and rebuild unpacked and installer artifacts.
- [x] 5.4 Run source, staged, ASAR, asset, and runtime privacy scans.
- [x] 5.5 Commit to Git, restart the packaged app, and verify one main process.

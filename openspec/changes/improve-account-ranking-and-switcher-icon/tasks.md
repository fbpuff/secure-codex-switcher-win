## 1. Specification And Baseline

- [x] 1.1 Record the current 65-point full-quota behavior and existing `CS` icon as the regression baseline.
- [x] 1.2 Strictly validate the OpenSpec proposal, design, ranking spec, icon spec, and task list before implementation.

## 2. Test-First Ranking Change

- [x] 2.1 Add failing tests for full quotas scoring 100, bottleneck weighting, one missing window, exhausted-window exclusion, and stable rounding.
- [x] 2.2 Add failing comparator tests for differences above 5 points, the inclusive 5-point boundary, limiting-window reset preference, missing reset times, and deterministic fallback order.
- [x] 2.3 Add failing renderer tests requiring `分 / points`, the new formula, close-score rule, and all four live quota/reset values.

## 3. Ranking Implementation And UI

- [x] 3.1 Replace the fixed four-factor score with the shared bottleneck-aware availability score.
- [x] 3.2 Apply the close-score reset tie-breaker consistently to automatic selection, account ordering, and manual-target fallback.
- [x] 3.3 Update bilingual metric labels, account detail, score help, examples, and documentation; remove percentage presentation for the calculated score.
- [x] 3.4 Verify full, constrained, close-score, missing-data, exhausted, stale, and reset-expired account behavior.

## 4. Account-Switching Product Icon

- [x] 4.1 Create a text-free icon with two account silhouettes and opposing switching arrows using the existing dark neutral and teal accent.
- [x] 4.2 Produce transparent PNG and multi-resolution ICO assets with clear 16, 24, 32, 48, and 256 pixel rendering.
- [x] 4.3 Apply the icon to the window, taskbar, tray, desktop shortcut, unpacked executable, and NSIS installer without adding a runtime graphics dependency.
- [x] 4.4 Visually inspect normal and small icon sizes and verify no text, clipped geometry, low-contrast detail, or obsolete cached shortcut target remains.

## 5. Verification And Delivery

- [x] 5.1 Run targeted ranking/UI/packaging tests, the full suite, JavaScript syntax checks, and strict OpenSpec validation.
- [x] 5.2 Rebuild the unpacked application and Windows installer and verify product name, executable identity, icon assets, and single-instance behavior.
- [x] 5.3 Run privacy scans across source, staged files, icon metadata, package contents, and ignored local runtime data.
- [x] 5.4 Commit the implementation to local Git, restart the packaged application, and verify one latest product-named main process with no development Electron instance.

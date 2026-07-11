## 1. Specification And Tests

- [x] 1.1 Record current account-table overflow, quota shorthand, chart-row drift, and asymmetric date control.
- [x] 1.2 Strictly validate this OpenSpec change before implementation.
- [x] 1.3 Add UI contract tests for six report groups, readable quota labels, no normal-width horizontal scrollbar, and narrow two-row accounts.
- [x] 1.4 Add chart tests for shared seven-row geometry, fixed row height, non-participating extrema badges, and one common date control.
- [x] 1.5 Add UI contract tests that every account-report group is centered and neither normal nor narrow layouts expose horizontal scrolling.

## 2. Compact Account Report

- [x] 2.1 Replace eight independent columns with account, attributed tokens, composition, usage overview, quota status, and confidence.
- [x] 2.2 Combine share, session count, and average per session into a readable usage overview.
- [x] 2.3 Replace `pp` and `R` shorthand with localized consumed-points and reset-count labels.
- [x] 2.4 Keep compact expected reset times in the row and expose full timestamps and definitions through contextual help.
- [x] 2.5 Remove normal desktop horizontal scrolling and add a coherent narrow two-row account layout.
- [x] 2.6 Center account headers and values consistently, including account identity, composition, quota, and confidence content.

## 3. Aligned Seven-Day Charts

- [x] 3.1 Move the statistics date control into one shared chart toolbar.
- [x] 3.2 Use identical seven-row grids, fixed row heights, and matching date/bar/value tracks in both panels.
- [x] 3.3 Position highest/lowest badges without changing row height.
- [x] 3.4 Keep values, percentages, cached-input definition, and chart explanations accessible in Chinese and English.
- [x] 3.5 Verify empty, partial, maximum-label, and longest localized-value states remain aligned.

## 4. Verification And Delivery

- [x] 4.1 Run targeted/full tests, syntax checks, strict OpenSpec validation, dependency audit, and diff checks.
- [x] 4.2 Visually verify reports and both charts in Chinese/English, light/dark, normal/narrow layouts.
- [x] 4.3 Update bilingual documentation, bump the release version, and rebuild unpacked and NSIS artifacts.
- [x] 4.4 Run source, staged, local-report schema, ASAR, asset, and runtime privacy scans.
- [x] 4.5 Commit to Git, restart the packaged app, and verify one product main process without development or remote-debugging instances.

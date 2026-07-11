## 1. Baseline And Tests

- [x] 1.1 Record the current hourly-rate columns, attribution behavior, capacity placement, and oval help control.
- [x] 1.2 Strictly validate this OpenSpec change.
- [x] 1.3 Add failing core tests for direct attribution, conflict-free session continuity, cross-account conflicts, coverage, sessions, composition, share, and average per session.
- [x] 1.4 Add failing tests for reset-aware 5h/7d consumed percentage points and reset counts.
- [x] 1.5 Add failing UI tests for the new table, coverage, secondary capacity evidence, metric help, removed hourly columns, and guaranteed circular control.

## 2. Attribution And Metrics

- [x] 2.1 Implement two-pass direct and session-continuity attribution without forcing conflicts.
- [x] 2.2 Add per-account confidence evidence, unique session count, average per session, and report share.
- [x] 2.3 Add overall attribution coverage and preserve unattributed composition.
- [x] 2.4 Calculate reset-aware quota consumption and reset counts per account/window.

## 3. Reports UI

- [x] 3.1 Replace hourly columns with intuitive account metrics in daily and weekly modes.
- [x] 3.2 Add compact token-composition, quota-change, confidence, and coverage presentation.
- [x] 3.3 Move capacity estimates into a secondary evidence section with representative value, range, count, and confidence.
- [x] 3.4 Add bilingual interactive metric explanations and local-only limitations.
- [x] 3.5 Override global button minimums so the availability help control remains a true 16-pixel circle in every state.

## 4. Verification And Delivery

- [x] 4.1 Run targeted tests, full tests, syntax checks, strict OpenSpec validation, and diff checks.
- [x] 4.2 Visually verify daily/weekly reports and help controls in Chinese/English, light/dark, and normal/narrow layouts.
- [x] 4.3 Update bilingual documentation, bump to 2.7.0, rebuild unpacked and NSIS artifacts, and verify product identity.
- [x] 4.4 Run source, staged, report-data, ASAR, asset, and runtime privacy scans.
- [x] 4.5 Commit to Git, restart the packaged app, and verify one product main process with no development or remote-debugging instance.

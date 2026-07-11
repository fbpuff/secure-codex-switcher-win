## 1. Specification And Tests

- [x] 1.1 Add regression tests for chart marker geometry, stable account-report rows, and centered model disclosures.
- [x] 1.2 Add tests for selected-account and scroll restoration across foreground and background refreshes.
- [x] 1.3 Add ranking tests for immediate eligibility and all-unavailable earliest-recovery fallback.

## 2. UI Repairs

- [x] 2.1 Repair seven-day chart extrema labels without overlap and keep both panels aligned.
- [x] 2.2 Rebuild the centered six-group account report with stable desktop and narrow geometry.
- [x] 2.3 Repair model/reasoning labels, token composition alignment, and centered disclosure controls.
- [x] 2.4 Preserve selected account, detail expansion, and scroll positions across refreshes.

## 3. Selection Semantics

- [x] 3.1 Keep immediate availability as a quota-only score with exhausted accounts ineligible.
- [x] 3.2 Add earliest-recovery fallback only when every candidate is immediately unavailable.
- [x] 3.3 Explain immediate availability and expected recovery separately in bilingual UI help.

## 4. Verification And Delivery

- [x] 4.1 Run focused and full tests, syntax checks, strict OpenSpec validation, audit, and diff checks.
- [x] 4.2 Verify normal/narrow and Chinese/English UI states against the supplied regressions.
- [x] 4.3 Bump version and rebuild unpacked and installer artifacts.
- [x] 4.4 Run source, staged, ASAR, asset, and runtime privacy scans.
- [x] 4.5 Commit to Git, restart the packaged app, and verify one product main process.

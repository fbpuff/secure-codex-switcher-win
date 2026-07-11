## 1. Baseline And Tests

- [x] 1.1 Record the 95.4-over-99.2 ranking reversal, compressed Chinese reset rows, and stale `CS` desktop icon as regression baselines.
- [x] 1.2 Strictly validate this OpenSpec change before implementation.
- [x] 1.3 Add failing ranking tests for strict score priority and exact-tie reset ordering.
- [x] 1.4 Add failing renderer tests for one-decimal scores, full-width reset rows, and normal/narrow responsive layout.
- [x] 1.5 Add failing packaging/shortcut tests for a versioned standalone ICO and cache-refresh behavior.

## 2. Implementation

- [x] 2.1 Remove the 5-point reversal band and apply exact-tie reset ordering everywhere the shared comparator is used.
- [x] 2.2 Display availability with one decimal place in metrics, help, account detail, replacement choices, and status messages.
- [x] 2.3 Restructure score-help markup and CSS into quota and reset groups with stable responsive dimensions.
- [x] 2.4 Add `shortcut-icon-2.5.2.ico`, recreate the desktop shortcut against it, and issue a non-destructive Explorer refresh.
- [x] 2.5 Update bilingual documentation and bump the packaged version to 2.5.2.

## 3. Verification And Delivery

- [x] 3.1 Run targeted tests, the full suite, JavaScript syntax checks, strict OpenSpec validation, and diff checks.
- [x] 3.2 Visually verify Chinese/English score help at normal and narrow widths and inspect the extracted executable and shortcut icons.
- [x] 3.3 Rebuild unpacked and NSIS artifacts and verify executable identity, shortcut target/icon, and single-instance behavior.
- [x] 3.4 Run source, staged-file, icon-metadata, ASAR, and local-runtime privacy scans.
- [x] 3.5 Commit to local Git, restart the packaged app, and verify one product-named main process with no development Electron instance.

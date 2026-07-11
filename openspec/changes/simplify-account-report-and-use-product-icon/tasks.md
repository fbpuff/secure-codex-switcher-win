## 1. Tests And Audit

- [x] 1.1 Add UI tests for a five-column account report with no quota-change content.
- [x] 1.2 Add reset tests proving independent 5h/7d boundaries and rejection of unconfirmed snapshot drops.
- [x] 1.3 Add packaging/UI tests that the internal brand uses the packaged product icon.
- [x] 1.4 Strictly validate the OpenSpec change.

## 2. Report Layout

- [x] 2.1 Remove the quota-change header, cells, formatter, and primary-table help mapping.
- [x] 2.2 Rebalance five column widths and center account content.
- [x] 2.3 Reduce row height and keep long masked emails and confidence labels readable.
- [x] 2.4 Preserve reset events only in the dedicated reset-history section.

## 3. Product Icon

- [x] 3.1 Replace the CSS rail symbol with `build/icon.png`.
- [x] 3.2 Keep icon sizing, contrast, and alignment consistent with the packaged and shortcut identity.

## 4. Verification And Delivery

- [x] 4.1 Run focused/full tests, syntax checks, strict validation, audit, and diff checks.
- [x] 4.2 Build and inspect account-report and brand screenshots at normal and narrow widths.
- [x] 4.3 Bump version and rebuild unpacked and installer artifacts.
- [x] 4.4 Run source, staged, ASAR, asset, and runtime privacy scans.
- [x] 4.5 Commit to Git, restart the packaged app, and verify one main process.

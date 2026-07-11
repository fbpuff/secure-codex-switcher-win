## 1. Tests And Specification

- [x] 1.1 Add regression tests for one-shot target consumption across queued and fallback paths.
- [x] 1.2 Add a UI regression test for a smaller centered circular help button.
- [x] 1.3 Strictly validate the OpenSpec change before implementation.

## 2. Implementation

- [x] 2.1 Consume the manual target only when an automatic switch attempt resolves a target.
- [x] 2.2 Preserve the resolved target in pending state while future switches return to best-score mode.
- [x] 2.3 Reduce and center the account-detail help control without changing its popover behavior.

## 3. Verification And Delivery

- [x] 3.1 Run focused and full tests, syntax checks, strict OpenSpec validation, and production audit.
- [x] 3.2 Package and visually verify the normal account-detail UI.
- [x] 3.3 Run source, staged, ASAR, asset, and runtime privacy scans.
- [x] 3.4 Commit to Git, restart the packaged application, and verify a single main window process.

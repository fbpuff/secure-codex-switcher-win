## 1. Tests And Specification

- [x] 1.1 Add a regression test that one background refresh performs one account-data commit.
- [x] 1.2 Add tests that account refresh does not rerender usage or report views.
- [x] 1.3 Add coverage for delaying background commits during active scrolling.
- [x] 1.4 Strictly validate the OpenSpec change.

## 2. Implementation

- [x] 2.1 Remove the intermediate current-account renderer commit.
- [x] 2.2 Split account-surface rendering from unrelated view rendering.
- [x] 2.3 Add passive scroll activity tracking and defer background commits until scrolling settles.
- [x] 2.4 Reduce account-card shadow repaint cost while preserving selection clarity.

## 3. Verification And Delivery

- [x] 3.1 Run focused/full tests, syntax checks, strict validation, and production audit.
- [x] 3.2 Package and verify scrolling and refresh behavior in the real application.
- [x] 3.3 Run source, staged, ASAR, and runtime privacy scans.
- [x] 3.4 Commit all changes, restart the packaged application, and verify one main window.

## 1. Tests And Specification

- [x] 1.1 Add lifecycle tests for started, completed, appended, partial, and malformed rollout records.
- [x] 1.2 Add service tests proving active or uncertain tasks keep automatic switching queued.
- [x] 1.3 Add target tests for current, stale, and renderer synchronization behavior.
- [x] 1.4 Strictly validate the OpenSpec change.

## 2. Implementation

- [x] 2.1 Add incremental privacy-preserving rollout lifecycle inspection.
- [x] 2.2 Make lifecycle activity a blocking signal for automatic switching.
- [x] 2.3 Reject current-account manual targets and normalize stale/current references.
- [x] 2.4 Refresh renderer settings after each automatic-switch evaluation.

## 3. Verification And Delivery

- [x] 3.1 Complete the shared vector help-icon task already in progress.
- [x] 3.2 Run focused/full tests, syntax checks, strict validation, and production audit.
- [x] 3.3 Package and inspect the UI and runtime behavior.
- [x] 3.4 Run source, staged, ASAR, and runtime privacy scans.
- [x] 3.5 Commit all changes, restart the packaged application, and verify one main window.

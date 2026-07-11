## 1. Baseline And Tests

- [x] 1.1 Confirm auth file changed while the pre-switch ChatGPT process remained alive and close count was zero.
- [x] 1.2 Strictly validate this OpenSpec change before implementation.
- [x] 1.3 Add generated-script tests showing a Switcher descended from ChatGPT still targets official ChatGPT processes in production mode.
- [x] 1.4 Add account-service tests for verified closure, no-running-process launch, and fail-closed remaining-process behavior.
- [x] 1.5 Add renderer tests preventing misleading restart status after an unverified close.

## 2. Real Switch Transaction

- [x] 2.1 Make generated PowerShell ancestor-tree exclusion opt-in.
- [x] 2.2 Keep cycle-safe exclusion behavior for explicit diagnostic callers.
- [x] 2.3 Count before and after close, then abort before auth backup/write if official processes remain.
- [x] 2.4 Preserve valid switching when ChatGPT Codex was not running.
- [x] 2.5 Return verified closure and launch evidence to the renderer.

## 3. Clear User State

- [x] 3.1 Distinguish verified restart, fresh launch with no prior process, and failed-to-close outcomes.
- [x] 3.2 Explain that a target marked `needs_login` may require login after a verified restart.
- [x] 3.3 Ensure no pseudo-success writes a new auth while the old official process still runs.

## 4. Verification And Delivery

- [x] 4.1 Run targeted/full tests, syntax checks, strict OpenSpec validation, audit, and diff checks.
- [x] 4.2 Verify count and close targeting against the real process table without terminating the active development session.
- [x] 4.3 Bump the release version, rebuild unpacked and NSIS artifacts, and verify product identity.
- [x] 4.4 Run source, staged, ASAR, runtime-data, and diagnostic privacy scans.
- [x] 4.5 Commit, restart the packaged app outside the official Codex process tree, and verify one product main process without debug instances.

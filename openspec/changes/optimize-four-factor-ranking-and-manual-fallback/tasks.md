## 1. Scope And Specification

- [x] 1.1 Confirm the existing remaining-only score, reset fields, ranking call sites, and strict manual-target failure path.
- [x] 1.2 Validate this OpenSpec change before implementation.

## 2. Four-Factor Ranking

- [x] 2.1 Add failing tests for the four weighted components, missing-component renormalization, reset-expired exclusion, deterministic tie-breaking, and reset-aware best-account selection.
- [x] 2.2 Implement the shared composite score breakdown, comparator, and eligibility checks without adding dependencies.
- [x] 2.3 Update AccountService and renderer ranking call sites to use the shared comparator and score.

## 3. Manual Target Fallback

- [x] 3.1 Replace the strict no-fallback test with failing tests for unavailable and unreadable manual targets falling back to the best usable account.
- [x] 3.2 Implement preflight manual-target fallback while preserving the configured manual preference and avoiding post-write retry loops.
- [x] 3.3 Record redacted fallback diagnostics and expose fallback status through queued/switched renderer flows.

## 4. UI And Documentation

- [x] 4.1 Update bilingual UI score descriptions and manual-fallback messages; show the composite score alongside the already-visible quota/reset components.
- [x] 4.2 Update English and Chinese README behavior/formula documentation.

## 5. Verification And Delivery

- [x] 5.1 Run targeted tests, the full test suite, JavaScript syntax checks, and strict OpenSpec validation.
- [x] 5.2 Inspect all changed/staged files for secrets and ensure runtime account, auth, session, log, and plugin-cache data remain excluded.
- [x] 5.3 Commit only project files to local Git.
- [x] 5.4 Restart Secure Codex Switcher from the D drive launcher and verify one latest main process.

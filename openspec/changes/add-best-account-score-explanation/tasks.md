## 1. Scope And Specification

- [x] 1.1 Confirm the current native-title behavior, shared score-breakdown API, summary layout, translations, and test structure.
- [x] 1.2 Write the approved score-help proposal, design, requirements, and implementation tasks.
- [x] 1.3 Run strict OpenSpec validation before implementation.

## 2. Test-First UI Contract

- [x] 2.1 Add failing tests for the visible help button, accessible popover relationship, bilingual formula content, dynamic breakdown hooks, and dismissal handlers.
- [x] 2.2 Run the targeted tests and confirm they fail because the score-help feature is absent.

## 3. Score Explanation UI

- [x] 3.1 Add the compact question-mark button and anchored popover beside the best-score label without changing metric dimensions.
- [x] 3.2 Render the fixed formula, reset-proximity explanation, missing-weight rule, eligibility note, winning account, total score, and four localized component values from `scoreBreakdown`.
- [x] 3.3 Implement hover, keyboard focus, click/touch pinning, repeated-click toggle, Escape dismissal, and outside-click dismissal with correct ARIA state.
- [x] 3.4 Add restrained responsive styling that remains coordinated with the existing summary strip in light and dark themes.

## 4. Verification And Delivery

- [x] 4.1 Run targeted tests, the full test suite, JavaScript syntax checks, and strict OpenSpec validation.
- [x] 4.2 Inspect changed and staged files for secrets; ensure auth, token, account-store, session, log, backup, cache, and dependency data remain excluded.
- [x] 4.3 Mark tasks complete only after their checks pass and commit only project files to local Git.
- [x] 4.4 Restart Secure Codex Switcher from the D-drive launcher and verify a single latest main process.

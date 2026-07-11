## Why

The summary metric exposes only the best account's composite score. Its fixed formula is hidden in a native title on the score value, so mouse, keyboard, and touch users cannot reliably discover the calculation or inspect the winning account's four current components.

## What Changes

- Add a small help button beside the best-score label without changing the summary metric dimensions.
- Show the fixed four-factor formula, missing-component behavior, eligibility note, and the current best account's score breakdown.
- Support hover, keyboard focus, click-to-pin, touch, Escape, and outside-click dismissal.
- Keep the content bilingual and reuse the shared ranking breakdown rather than duplicating score calculations.

## Capabilities

### New Capabilities

- `best-account-score-explanation`: Defines the score-help content, interaction states, accessibility, and responsive layout.

### Modified Capabilities

None. The scoring algorithm remains unchanged.

## Impact

- Renderer markup, translations, rendering, and styles.
- Renderer contract tests for content and interaction wiring.
- No new dependency, account data, remote request, credential access, or scoring behavior change.

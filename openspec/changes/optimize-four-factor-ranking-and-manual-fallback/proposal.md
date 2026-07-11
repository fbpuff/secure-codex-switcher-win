## Why

The current best-account score uses only remaining 5-hour and 7-day quota, and manual-target mode stops automatic switching when the selected account is unavailable. Account selection should account for both remaining quota and reset proximity, while preserving the user's preferred target without allowing one bad account to block switching.

## What Changes

- Replace the remaining-only score with a four-factor score: 5-hour remaining, 7-day remaining, 5-hour reset proximity, and 7-day reset proximity.
- Keep the current account first and the configured manual target second; sort all remaining accounts with the new score and deterministic tie-breakers.
- When a manual target is unavailable or its encrypted local record cannot be read, keep the preference but use the highest-scored usable fallback for that switch event.
- Expose the new score and fallback reason in UI status/diagnostics, and document the exact formula.

## Capabilities

### New Capabilities

- `four-factor-account-ranking`: Defines score calculation, missing-data behavior, eligibility, tie-breaking, and list ordering.
- `manual-target-fallback`: Defines safe fallback from an unavailable manually selected target.

### Modified Capabilities

None. Related earlier changes are complete but have not been archived into base specs.

## Impact

- Shared ranking logic and ranking tests.
- AccountService list ordering, target resolution, auto-switch state, and diagnostics.
- Renderer score/fallback text and bilingual documentation.
- No new dependency, account format, remote service, or credential storage.

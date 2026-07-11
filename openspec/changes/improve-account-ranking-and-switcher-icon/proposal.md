## Why

The current composite score treats distant reset times as a penalty, so an account with 100% remaining in both windows can display only 65 points. Reset timing describes recovery, not current availability, and should not reduce a fully available account's score. The current letter-based application icon also does not communicate account switching at taskbar and tray sizes.

## What Changes

- Replace the fixed four-factor percentage with a bottleneck-aware availability score that reaches 100 when both quotas are full.
- Use reset timing only as a close-score ranking tie-breaker, while retaining all existing eligibility and deterministic ordering rules.
- Update score labels, explanations, examples, and breakdowns so the UI distinguishes points from official quota percentages.
- Replace the `CS` icon with a text-free two-account switching symbol and apply it consistently to the window, taskbar, tray, shortcut, unpacked executable, and installer.

## Capabilities

### New Capabilities

- `bottleneck-account-ranking`: Defines the availability score, close-score reset tie-breaker, missing-data behavior, and stable account ordering.
- `account-switching-product-icon`: Defines the icon concept, required Windows assets, small-size legibility, and packaged identity checks.

### Modified Capabilities

None. The related earlier changes are complete but have not been archived into base specs.

## Impact

- Shared ranking logic and ranking tests.
- Renderer score labels, help popover, account details, and bilingual documentation.
- PNG/ICO assets, packaged executable, installer, and desktop shortcut.
- No quota endpoint, account storage, authentication, or privacy-boundary change.

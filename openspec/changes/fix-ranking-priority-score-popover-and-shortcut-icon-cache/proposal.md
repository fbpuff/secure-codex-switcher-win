## Why

The 5-point reset tie-breaker can rank a 95.4-point account above a 99.2-point account, contradicting the availability score shown to the user. The score help layout compresses Chinese reset labels and timestamps into an unreadable two-column grid. Windows Explorer also keeps showing the retired `CS` shortcut icon because the shortcut references an unchanged executable path whose icon is cached.

## What Changes

- Make raw availability score the strict primary ordering key and use reset timing only for exactly equal raw scores.
- Show availability with one decimal place while preserving the upstream quota percentages without rounding 99% into 100%.
- Restructure the score help into a compact quota grid plus full-width reset rows with responsive label sizing.
- Create a versioned shortcut ICO, recreate the desktop shortcut to reference it, and notify Explorer to refresh its icon cache.

## Capabilities

### New Capabilities

- `strict-availability-ranking`: Defines score-first ordering, exact-tie reset behavior, and decimal score presentation.
- `responsive-score-help`: Defines readable quota and reset layouts at normal and narrow widths.
- `versioned-shortcut-icon`: Defines cache-resistant desktop shortcut icon handling.

## Impact

- Ranking comparator, renderer formatting and score-help layout.
- Ranking, renderer, and packaging tests.
- Packaged assets, launcher/shortcut behavior, documentation, and Windows artifacts.
- No authentication, quota source, account storage, or privacy-boundary change.

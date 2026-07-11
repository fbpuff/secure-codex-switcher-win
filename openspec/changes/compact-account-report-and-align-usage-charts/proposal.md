# Compact Account Report And Align Usage Charts

## Why

The account report still requires horizontal scrolling because eight columns compete for width. Quota values use unexplained `pp` and `R` abbreviations. The two seven-day charts use different row sizing and footer structure, so matching dates and bars drift out of alignment.

## What Changes

- Consolidate the account report into six information groups that fit the normal desktop viewport without a bottom scrollbar.
- Replace `pp` and `R` shorthand with readable localized labels and contextual explanation.
- Use a two-line account layout on narrow viewports instead of preserving a wide table.
- Make both seven-day charts share one fixed row grid, label geometry, and common date control.
- Keep highest/lowest badges out of row-height calculations.

## Privacy

Only existing local aggregate presentation changes. No account records, credentials, token events, quota snapshots, sessions, or report files enter Git or application assets.

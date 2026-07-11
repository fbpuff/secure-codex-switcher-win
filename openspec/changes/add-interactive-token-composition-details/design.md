# Design

## Shared composition control

Reuse one renderer helper for account and model rows. The control is a native button containing a short stacked bar. Its adjacent fixed-position popover contains a CSS conic-gradient donut, a four-row legend, exact values, percentages, and explanatory text. No chart dependency is added.

Hover and focus preview the popover. Activation pins it. Only one control can be pinned. Escape and outside click close it. Positioning clamps the popover to the viewport.

## Alignment

Use explicit column classes rather than centering every header. Identity and explanatory columns align left. Numeric columns align right. Composition controls use a stable compact width. Quota text wraps inside a bounded column.

## Model disclosure

Each model/reasoning combination is a native button-like disclosure row with account, model, effort, total tokens, and the composition bar. Activation expands one details band containing exact composition and 5h/7d capacity evidence. One expanded model row per report is sufficient.

## Accessibility

Buttons expose `aria-expanded` and localized labels. Popovers use `role=dialog`, remain keyboard reachable, and never rely on hover alone. Donut information is duplicated as text.

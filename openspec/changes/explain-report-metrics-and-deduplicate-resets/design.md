# Design

## Metric explanations

Reuse one small native HTML/CSS help pattern. Each major report block receives a circular question-mark control with bilingual text covering definition, formula, interpretation, and limitation. Column labels use native `title` text for immediate explanations.

## Token composition

Use one stacked CSS bar. Since cached input is included in input, calculate `nonCachedInput = max(0, input - cachedInput)`. Segment percentages use the non-overlapping sum of non-cached input, cached input, output, and reasoning. Text remains available to screen readers and on hover.

## Reset identity

A reset identity is `(accountId, window, previousResetAt)` when the previous boundary is known. Fall back to a short confirmation-time bucket only for legacy events without that boundary. Detection and report projection both deduplicate by this identity so existing local history is readable without rewriting private data.

The report maps internal account IDs to masked labels. `atMs` remains the local detection/confirmation time. `previousResetAt` is the upstream expected boundary associated with the prior quota cycle.

## Expected resets

For each account/window, expose the latest snapshot's `resetAt` as `nextResetAt`. It is explicitly labeled expected, not guaranteed, and may change after refresh.

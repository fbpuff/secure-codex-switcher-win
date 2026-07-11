# Design

## Process targeting

`officialCodexProcessScript` already supports an explicit tree-exclusion concept in the JavaScript helper. The PowerShell generator shall make it opt-in rather than unconditional. Production count and close calls pass no exclusion because the Switcher executable is independently identified and never satisfies official-process matching.

The cycle-safe traversal remains available for test and diagnostic callers that explicitly request ancestor exclusion.

## Switch transaction

The transaction is:

1. Count official processes before close.
2. Request close.
3. Count again.
4. If any official process remains, abort before backup or auth write.
5. Otherwise write the selected encrypted auth and launch ChatGPT Codex.

An initial count of zero is valid: the auth may be replaced and ChatGPT Codex launched. A count above zero followed by zero remaining processes is a real restart path. A count above zero with remaining processes is a fail-closed error rather than a pseudo-switch.

## Status evidence

Switch results include whether official processes were running before the transaction and whether a process was actually closed. Renderer status text treats a launch as a new start only after the close transaction was verified; it does not infer success from merely activating an existing app.

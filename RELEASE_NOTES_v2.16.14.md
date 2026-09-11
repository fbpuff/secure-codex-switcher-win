# Secure Codex Switcher v2.16.14

## Runtime corrections

- Keep automatic task continuation in Codex Desktop so approval and user-input requests remain visible and interactive.
- Read the current account's displayed quota windows from the latest Codex `rate_limits` event and attribute them through the local active-account timeline.
- Show only the quota windows Codex actually supplies; keep stored account-level usage unchanged for ranking and automatic switching.

## Verification boundary

- Source, tests, OpenSpec, packaging, and installed-runtime evidence are required before release closure.
- A real quota-triggered account switch remains unclaimed because it would restart or switch Codex without separate current-task authorization.

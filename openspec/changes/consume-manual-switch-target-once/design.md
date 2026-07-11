## Context

Manual target state lives in settings and is read by both account ordering and auto-switch resolution. Nothing currently clears it after an attempted automatic switch, so the one-shot UI wording and persistent service behavior disagree.

## Decisions

- Consume the manual preference in `evaluateAutoSwitch`, immediately after target resolution. This is the shared boundary for direct, queued, fallback, and unavailable outcomes.
- Do not consume it while the current account remains usable, because no switch has been attempted.
- A queued switch retains its resolved account in auto-switch state; clearing settings does not change that in-flight target.
- Failed switch attempts also consume the preference to prevent repeated attempts against a broken account.
- Use CSS-only sizing/alignment changes for the help control.

## Privacy

No account identifiers, credentials, usage records, logs, reports, or runtime state are added to Git. Tests use synthetic fixtures only.


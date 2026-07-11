## Decisions

- Keep the existing data refresh APIs and remove the intermediate renderer commit after refreshing only the current account.
- Split account rendering from usage/report rendering so account refresh does not rebuild unrelated views.
- Track scroll activity passively and wait for a short idle window only for background commits. User actions remain immediate.
- Preserve existing scroll capture/restore as a fallback for necessary account DOM replacement.

## Privacy

No runtime account, usage, report, log, or session data is added to source control.


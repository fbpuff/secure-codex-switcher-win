## Decisions

- A token event inside one active-account interval is `high` confidence.
- An event outside an interval may be attributed with `medium` confidence only when the same rollout session has direct events for exactly one account and no direct event for another account.
- Sessions with direct evidence for multiple accounts remain split for direct events; gap events remain unattributed.
- Coverage is attributed local tokens divided by all local tokens in the selected report interval.
- Session count uses unique rollout session IDs. Average per session is attributed tokens divided by unique sessions.
- Quota change sums positive used-percentage-point deltas only within the same reset window and never crosses a reset event.
- Capacity remains observational evidence and moves below the primary account table with count, range, median, and confidence.
- The detail help control explicitly overrides global button minimum dimensions.
- Version becomes 2.7.0.

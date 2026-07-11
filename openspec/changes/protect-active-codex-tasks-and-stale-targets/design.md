## Decisions

- Scan recent rollout JSONL files incrementally and cache per-file lifecycle state.
- `task_started` sets an active task; `task_complete` clears it.
- A malformed complete JSONL record makes activity uncertain and blocks automatic closure; a trailing partial line is retained for the next scan.
- Automatic switching remains queued while any recent session has an active task. Manual user-confirmed switching is unchanged.
- Service-layer target validation is authoritative because renderer state can race with auth reconciliation.

## Privacy

Only event types and file offsets are held in memory. Message content, prompts, tool arguments, account identifiers, credentials, and session contents are not persisted or logged.


# Secure Codex Switcher v2.16.13

## Runtime correction

- Persist completed-thread read state in the main process per account.
- Remove renderer-only completed-item hiding so opened items remain hidden after reload.
- Remove the compact-window left/right choice control; drag-end geometry determines the nearer screen edge and snaps automatically.
- Add regression coverage for account isolation and persistence of completed-thread read markers.

## Verification

- Full test suite: 610/610 passed.
- Edge/account focused suite: 151/151 passed.
- Formal packaging and installed-runtime verification are required for this version before release closure.

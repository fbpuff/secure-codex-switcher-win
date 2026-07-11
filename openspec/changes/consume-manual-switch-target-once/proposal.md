# Change: Consume manual switch target once

## Why

The UI describes a manually selected account as the next auto-switch target, but the persisted preference is currently reused by every later auto-switch. The account-detail help button is also visually larger and vertically off-center beside its label.

## What Changes

- Treat a manually selected auto-switch target as a one-shot preference.
- Consume the preference when an auto-switch attempt resolves the requested target, including fallback and no-target outcomes.
- Preserve an already queued target while clearing the manual preference for future switches.
- Keep later switches on best-score selection unless the user chooses another target.
- Reduce and center the account-detail help button.


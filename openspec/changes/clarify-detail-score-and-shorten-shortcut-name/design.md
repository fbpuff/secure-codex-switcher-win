## Decisions

- Reuse the existing question-mark visual language but give account detail its own hover/focus popover so the control remains local to the displayed score.
- Show one row: `Account availability [?]` and the one-decimal point value.
- Keep the formula unchanged and avoid the internal phrase `Bottleneck-aware score` in visible UI.
- Set NSIS `shortcutName` to `Codex Switcher` and make the launcher create `Codex Switcher.lnk`.
- Delete only `%USERPROFILE%\Desktop\Secure Codex Switcher.lnk`; do not broadly remove shortcuts or change the EXE/product/data-directory names.
- Bump the packaged application to 2.5.4.

## ADDED Requirements

### Requirement: Short shortcut label
The launcher and installer SHALL name the user-facing shortcut `Codex Switcher` while preserving `Secure Codex Switcher.exe` and the formal product name.

#### Scenario: Version 2.5.4 starts
- **WHEN** the launcher refreshes the desktop shortcut
- **THEN** `Codex Switcher.lnk` targets the packaged executable and uses the versioned icon

### Requirement: Precise retired-shortcut cleanup
The launcher SHALL remove only the exact retired `Secure Codex Switcher.lnk` desktop shortcut after the new shortcut is created.

#### Scenario: Old shortcut exists
- **WHEN** shortcut refresh succeeds
- **THEN** the old exact shortcut is removed and unrelated shortcuts are preserved

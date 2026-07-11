## ADDED Requirements

### Requirement: Account-switching icon semantics
The product icon SHALL use a text-free symbol containing two account silhouettes and opposing switching arrows.

#### Scenario: Icon is shown at application size
- **WHEN** the icon is displayed in the window, taskbar, tray, desktop shortcut, or installer
- **THEN** the account-switching concept remains recognizable without relying on letters

### Requirement: Windows icon consistency
The packaged executable, installer, desktop shortcut, window, taskbar, and tray SHALL use the same approved icon identity.

#### Scenario: Packaged app is rebuilt and launched
- **WHEN** the user starts the packaged application
- **THEN** Windows surfaces use the new icon and the process remains named `Secure Codex Switcher.exe`

### Requirement: Small-size legibility
The icon SHALL retain distinct account and arrow shapes at common Windows icon sizes.

#### Scenario: Icon is rendered at 16 and 24 pixels
- **WHEN** Windows downsizes the icon for tray or compact taskbar use
- **THEN** the symbol remains high contrast and does not collapse into unreadable text or fine detail

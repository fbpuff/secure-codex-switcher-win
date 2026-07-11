## ADDED Requirements

### Requirement: Cache-resistant shortcut icon
The desktop shortcut SHALL reference a versioned standalone ICO path rather than the unchanged executable icon path.

#### Scenario: Shortcut is recreated after upgrade
- **WHEN** version 2.5.2 is packaged
- **THEN** the shortcut target is the packaged executable and its icon location is `shortcut-icon-2.5.2.ico`

### Requirement: Non-destructive Explorer refresh
The upgrade SHALL notify Explorer of the icon change without deleting unrelated icon cache files or restarting the computer.

#### Scenario: Existing shortcut used the retired icon
- **WHEN** shortcut recreation completes
- **THEN** a shell refresh notification is issued and the shortcut resolves to the new switching icon

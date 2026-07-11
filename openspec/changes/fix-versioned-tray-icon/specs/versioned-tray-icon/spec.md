## ADDED Requirements

### Requirement: Cache-independent tray icon
The packaged application SHALL load its tray icon from a versioned standalone PNG and SHALL NOT replace it with an icon obtained from the executable path.

#### Scenario: Application minimizes to tray
- **WHEN** the packaged application creates or updates its tray item
- **THEN** the tray displays `tray-icon-2.5.3.png` without consulting the executable icon cache

### Requirement: Tray-only window state
The application SHALL hide its window when the configured close behavior is tray.

#### Scenario: User minimizes to tray
- **WHEN** the tray close behavior is applied
- **THEN** the tray item remains available and the hidden window is not left as an active taskbar window

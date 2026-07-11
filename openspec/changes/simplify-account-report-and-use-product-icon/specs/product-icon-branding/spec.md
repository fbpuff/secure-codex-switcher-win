## ADDED Requirements

### Requirement: Internal branding uses the packaged icon asset
The application shell SHALL render the same packaged product icon asset used for executable and shortcut identity.

#### Scenario: Main shell loads
- **WHEN** the application window opens
- **THEN** the rail brand displays `build/icon.png` without a separate CSS-drawn mark

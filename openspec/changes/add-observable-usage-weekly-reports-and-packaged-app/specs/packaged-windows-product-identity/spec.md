## ADDED Requirements

### Requirement: Product-named Windows executable
The production application SHALL run from a packaged executable named `Secure Codex Switcher.exe` with matching product metadata, application user model ID, version, and icon.

#### Scenario: User inspects Task Manager
- **WHEN** the production app is running
- **THEN** Windows identifies the main process using the Secure Codex Switcher product identity rather than the generic development `electron.exe`

### Requirement: Packaged launcher behavior
The standard launcher and desktop shortcut SHALL start the packaged executable, while development launch remains an explicit separate command.

#### Scenario: Packaged executable is available
- **WHEN** the user launches Secure Codex Switcher normally
- **THEN** the launcher starts the packaged application and does not silently choose the generic development runtime

#### Scenario: Packaged executable is missing
- **WHEN** the normal launcher cannot find the packaged artifact
- **THEN** it reports a clear actionable error without modifying account data or falling back invisibly

### Requirement: Upgrade preserves local state
Packaging and upgrades SHALL preserve encrypted accounts, settings, observations, weekly reports, diagnostics, and backups in local application data while excluding them from the distributable artifact.

#### Scenario: User installs a newer packaged build
- **WHEN** the new build starts against existing local state
- **THEN** compatible state is retained or safely migrated and no credential or private runtime file is embedded in the package

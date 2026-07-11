# Windows Proxy Fallback

## ADDED Requirements

### Requirement: Proxy precedence

The packaged application SHALL use explicit proxy environment variables first and otherwise use the enabled Windows current-user proxy.

#### Scenario: Desktop shortcut starts without proxy environment

- **WHEN** Windows proxy is enabled and no proxy environment variable exists
- **THEN** usage refresh SHALL use the Windows proxy without requiring the launcher script

#### Scenario: Explicit proxy exists

- **WHEN** an explicit proxy environment variable and Windows proxy both exist
- **THEN** the explicit environment proxy SHALL win

### Requirement: Actionable sanitized failure

Network failures SHALL identify the likely direct/proxy condition without exposing credentials or Electron IPC implementation text.

#### Scenario: Usage refresh cannot connect

- **WHEN** both usage endpoints fail to connect
- **THEN** the UI SHALL present a concise actionable cause
- **AND** SHALL NOT display `Error invoking remote method`

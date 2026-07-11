## ADDED Requirements

### Requirement: Durable pending switch state
The system SHALL persist pending auto-switch state locally when an exhausted current account cannot switch immediately because Codex activity is still busy or recently active.

#### Scenario: Switch is queued
- **WHEN** the current account is exhausted, auto-switch is enabled, a usable target exists, and activity detection says to wait
- **THEN** the system persists the pending target and waiting reason in local app state

#### Scenario: App restarts while queued
- **WHEN** the app restarts and a pending auto-switch state exists
- **THEN** the system can display the pending state and continue evaluating whether the switch can proceed

### Requirement: Queue revalidation
Before executing a pending auto-switch, the system SHALL revalidate the current account, target account, target mode, usage freshness, and remaining quota.

#### Scenario: Current account recovers
- **WHEN** a pending switch exists and refreshed current-account usage is no longer exhausted
- **THEN** the system clears the pending switch and reports that the queue was cancelled

#### Scenario: Target becomes invalid
- **WHEN** a pending switch exists and the target account is no longer usable
- **THEN** the system either reports the manual target problem or resolves a new best-score target according to the active target mode

### Requirement: Activity PID validation
The system SHALL only treat a recorded chat-process PID as active Codex work when the current OS process for that PID still matches official Codex process identity rules.

#### Scenario: PID was reused by another application
- **WHEN** `chat_processes.json` contains a PID that is alive but the process name or executable path is not official Codex
- **THEN** the system does not count that PID as active Codex work

#### Scenario: PID still belongs to official Codex
- **WHEN** `chat_processes.json` contains a PID that is alive and matches official Codex identity rules
- **THEN** the system counts that PID as active Codex work

### Requirement: Safe switch execution
The system SHALL execute account switching only after the target has been revalidated and activity detection indicates that switching is allowed.

#### Scenario: Activity is idle
- **WHEN** a pending target is usable and Codex activity is idle long enough
- **THEN** the system writes the target auth, applies the target transport preference, closes official Codex processes, and launches official Codex as existing switch behavior does

#### Scenario: Switch execution fails
- **WHEN** account switching throws an error
- **THEN** the system preserves or updates pending state with the failure reason and exposes the failure to the UI

## ADDED Requirements

### Requirement: User-visible switch status
The system SHALL show a clear status message for the latest auto-switch decision, including whether switching is disabled, waiting, cancelled, blocked by target availability, failed, or completed.

#### Scenario: Manual target unavailable
- **WHEN** auto-switch cannot proceed because the selected manual target is unavailable
- **THEN** the UI shows a message naming the masked target and the availability reason

#### Scenario: Waiting for activity
- **WHEN** auto-switch is queued because Codex activity is busy or recently active
- **THEN** the UI shows the queued target and waiting reason

### Requirement: Local diagnostic history
The system SHALL maintain a bounded local diagnostic history of auto-switch decisions and outcomes.

#### Scenario: Decision is recorded
- **WHEN** the system evaluates auto-switch eligibility
- **THEN** it records a redacted local diagnostic event with event type, timestamp, target mode, masked account label when available, and decision reason

#### Scenario: Diagnostic history is bounded
- **WHEN** diagnostic history exceeds the configured retention bound
- **THEN** the system prunes old diagnostic events while keeping recent decisions

### Requirement: Diagnostic privacy
Diagnostic status and history MUST NOT include raw auth JSON, access tokens, refresh tokens, API keys, bearer tokens, conversation text, or full local session contents.

#### Scenario: Switch fails during auth write
- **WHEN** a switch failure is recorded
- **THEN** the diagnostic event contains only a redacted error message and non-sensitive account metadata

#### Scenario: Usage refresh fails
- **WHEN** a usage refresh error contributes to an auto-switch decision
- **THEN** the diagnostic event stores the existing redacted error summary rather than raw request headers or token values

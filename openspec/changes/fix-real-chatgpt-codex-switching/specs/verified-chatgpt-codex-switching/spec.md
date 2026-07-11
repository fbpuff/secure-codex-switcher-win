# Verified ChatGPT Codex Switching

## ADDED Requirements

### Requirement: Real official-process targeting

The normal Switcher close operation SHALL target official ChatGPT Codex processes even when the Switcher is descended from an official ChatGPT Codex process.

#### Scenario: Switcher was launched from ChatGPT Codex

- **WHEN** the Switcher process has `ChatGPT.exe` as an ancestor
- **AND** an official ChatGPT Codex desktop process is running
- **THEN** normal close targeting SHALL include that official process
- **AND** SHALL NOT exclude the entire ancestor tree

### Requirement: Verified close before auth write

The system SHALL verify that no official ChatGPT Codex process remains before writing replacement auth when one was running.

#### Scenario: Close cannot terminate the old app

- **WHEN** official processes remain after a close request
- **THEN** switching SHALL fail before auth backup or replacement
- **AND** the existing auth file SHALL remain unchanged

#### Scenario: No app was running

- **WHEN** no official process exists before a switch
- **THEN** the system SHALL write replacement auth and launch ChatGPT Codex

### Requirement: Honest result state

The renderer SHALL distinguish a verified restart from a fresh launch and from a failed close.

#### Scenario: Existing app was not verified closed

- **WHEN** the close transaction is not verified
- **THEN** the renderer SHALL NOT report that ChatGPT Codex was restarted

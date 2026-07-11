## ADDED Requirements

### Requirement: Trusted ChatGPT Codex session identity
The system SHALL identify a ChatGPT Codex session only when its executable name is `ChatGPT.exe` or `codex.exe` and its executable path matches an approved official OpenAI package or runtime path.

#### Scenario: Current desktop application is running
- **WHEN** the Microsoft Store package runs `ChatGPT.exe` under an `OpenAI.Codex_*` installation path
- **THEN** the system includes it in the official ChatGPT Codex session process set

#### Scenario: Unrelated process has a matching name
- **WHEN** a process named `ChatGPT.exe` or `codex.exe` is outside approved official paths
- **THEN** the system excludes it from the official ChatGPT Codex session process set

### Requirement: Clean account-switch restart
The system SHALL close the trusted ChatGPT Codex session before changing the active local auth cache and SHALL relaunch the current official application identity afterward.

#### Scenario: Account changes
- **WHEN** a saved account differs from the active account and switching is allowed
- **THEN** the system closes the trusted ChatGPT Codex session, writes the selected auth cache, and launches ChatGPT Codex

#### Scenario: User-visible terminology
- **WHEN** the application reports account-switch lifecycle status or errors
- **THEN** it names the current product ChatGPT Codex and does not present `.codex` storage as the desktop product name

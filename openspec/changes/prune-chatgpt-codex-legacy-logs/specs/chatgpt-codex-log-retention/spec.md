## ADDED Requirements

### Requirement: Dated diagnostic log cleanup boundary
The cleanup process SHALL remove only the explicitly selected historic ChatGPT Codex diagnostic-log directory and SHALL not remove sibling current log directories or non-log data.

#### Scenario: June 2026 logs are selected
- **WHEN** the resolved cleanup target is `%LOCALAPPDATA%\Codex\Logs\2026\06`
- **THEN** the process removes that directory and does not target `.codex`, `AppData\Roaming\Codex`, `AppData\Local\OpenAI\Codex`, or `Logs\2026\07`

### Requirement: Post-cleanup verification
The cleanup process SHALL verify that the selected historic directory is absent and that the current July 2026 log directory remains present.

#### Scenario: Cleanup completes
- **WHEN** deletion returns successfully
- **THEN** the process reports the deleted file count and confirms the July log directory still exists

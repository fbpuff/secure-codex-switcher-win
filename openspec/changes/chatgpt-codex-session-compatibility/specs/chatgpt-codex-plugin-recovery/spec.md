## ADDED Requirements

### Requirement: Narrow local plugin recovery
The system SHALL provide an explicit local recovery script for the verified NGS manifest-length and Sites MCP `resources/list` compatibility defects.

#### Scenario: Known incompatible artifacts are present
- **WHEN** the recovery script finds the identified NGS manifest or bundled Sites MCP server in the local Codex plugin cache
- **THEN** it creates a timestamped backup and applies only the required compatibility edit

#### Scenario: Artifacts are already repaired or absent
- **WHEN** the recovery script runs after a successful repair or cannot find one of the identified artifacts
- **THEN** it reports the artifact state without deleting files or failing the remaining recovery work

### Requirement: Recovery privacy boundary
The recovery script MUST NOT read, write, copy, or print local auth caches, tokens, account stores, session data, or `config.toml` values.

#### Scenario: Recovery execution
- **WHEN** the recovery script is executed
- **THEN** its output contains only artifact paths, backup paths, and repair status with no credential or session content

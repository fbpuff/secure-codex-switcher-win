## ADDED Requirements

### Requirement: Reset rows remain readable
The score help SHALL render reset labels and timestamps in full-width rows without splitting Chinese labels character by character.

#### Scenario: Chinese score help at normal width
- **WHEN** the score help is shown in Chinese
- **THEN** each reset label remains intact and its timestamp has sufficient width

#### Scenario: Narrow viewport
- **WHEN** the available width cannot support the normal layout
- **THEN** the breakdown switches to one column without horizontal overflow or overlap

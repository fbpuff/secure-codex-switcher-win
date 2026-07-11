## ADDED Requirements

### Requirement: Unfinished Codex tasks block automatic closure

The system SHALL keep automatic switching queued while a local Codex rollout contains an unmatched task start or its lifecycle state cannot be safely determined.

#### Scenario: Task is still running

- **WHEN** the latest lifecycle event is `task_started`
- **THEN** automatic switching remains queued and ChatGPT Codex is not closed

#### Scenario: Task explicitly completes

- **WHEN** a matching later `task_complete` event is observed and no other busy signal remains
- **THEN** the normal quiet-period rules may allow automatic switching

### Requirement: Manual target references remain valid

The system SHALL reject the current account as a manual target and SHALL clear target references that no longer resolve to a saved non-current account.

#### Scenario: Target becomes current or disappears

- **WHEN** automatic target resolution finds the stored target is current or absent
- **THEN** the stale preference is cleared and the renderer synchronizes to the resulting target state


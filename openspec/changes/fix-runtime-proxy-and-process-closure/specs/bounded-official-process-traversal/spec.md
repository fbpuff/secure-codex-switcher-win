# Bounded Official Process Traversal

## ADDED Requirements

### Requirement: Bounded traversal

Official-process discovery SHALL terminate when process metadata contains a self-cycle, multi-node cycle, stale parent link, or reused PID.

#### Scenario: Unrelated process has a parent cycle

- **WHEN** the Windows process snapshot contains an unrelated cyclic parent chain
- **THEN** official process count SHALL return without waiting for the closure timeout
- **AND** official ChatGPT Codex targets SHALL remain correctly identified

### Requirement: Current host family

Official-process discovery SHALL recognize the packaged ChatGPT Codex desktop, app server, and code-mode host while excluding unrelated similarly named programs.

#### Scenario: Current packaged app is running

- **WHEN** ChatGPT Codex runs from an `OpenAI.Codex_*` package path
- **THEN** its recognized process family SHALL participate in closure
- **AND** the active invoking official Codex tree SHALL remain excluded when requested

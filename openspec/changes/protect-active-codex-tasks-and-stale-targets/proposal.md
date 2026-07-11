# Change: Protect active Codex tasks and stale targets

## Why

Auto-switch currently infers task completion from process registration and short file-silence windows. Long reasoning or tool execution can therefore be misclassified as idle, allowing the switcher to close ChatGPT Codex and interrupt an unfinished task. Manual target IDs can also become stale while the renderer continues to show an outdated target badge.

## What Changes

- Parse local rollout task lifecycle events and treat unmatched `task_started` as busy.
- Keep automatic switching queued when task state is active or uncertain.
- Retain process and recent-write checks as supporting signals, not completion proof.
- Reject current-account manual targets and clear stale/current target references before fallback.
- Resynchronize renderer settings after every automatic-switch evaluation.


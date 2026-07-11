## Context

`remainingScore` currently computes `7d remaining * 0.7 + 5h remaining * 0.3`. `pickBestAccount`, AccountService list sorting, renderer metrics, and replacement-account options all depend on it. Usage snapshots already contain `usedPercent`, `resetAt`, and `fetchedAt`, so no new data source is required.

Manual-target mode currently returns `target_unavailable` when the selected account is missing, stale, exhausted, or not ready. This blocks automatic switching even if another saved account is usable.

## Goals / Non-Goals

**Goals:**

- Use one shared four-factor score everywhere accounts are ranked.
- Preserve current-first/manual-target-second list placement and sort the rest consistently.
- Fall back for the current switch event when the manual target is unusable or unreadable, without clearing the stored preference.
- Keep exhausted, stale, failed-login, or reset-expired snapshots out of the auto-switch candidate set.
- Show the score formula and manual fallback outcome without exposing sensitive data.

**Non-Goals:**

- Changing quota endpoints, auth encryption, account storage, or auto-switch activity waiting.
- Repeatedly switching after an ambiguous failure that occurs after the active auth file may have changed.
- Adding configurable weights in this iteration.

## Decisions

### Decision 1: Fixed four-factor weights

Use 30% for 5-hour remaining, 35% for 7-day remaining, 15% for 5-hour reset proximity, and 20% for 7-day reset proximity. Remaining quota stays dominant while the longer 7-day constraint remains strategically important.

Reset proximity is `100 * (1 - secondsUntilReset / windowDuration)`, clamped to 0-100. When a component is missing, divide by the sum of available weights so missing values do not create a false zero. A known reset time at or before `now` makes the snapshot ineligible until refreshed.

### Decision 2: One shared comparator

Export a shared composite-score breakdown and comparator from `ranking.js`. AccountService and renderer use it rather than duplicating score math. Ties prefer greater 7-day remaining, then greater 5-hour remaining, then the nearer known reset, then older creation order for stability.

### Decision 3: Preflight fallback only

Resolve the manual target first. If it fails readiness, freshness, quota, reset-time, or encrypted-record readability checks, choose the best remaining usable/readable account and attach a redacted fallback reason. Preserve the manual preference so a temporary issue does not erase user intent.

Do not continue to another account after a generic `switchAccount` failure because that operation can fail after `auth.json` has changed; continuing would make active-account state ambiguous.

## Risks / Trade-offs

- [Risk] Reset fields may be absent. -> Mitigation: renormalize available component weights and show unknown values in the existing UI.
- [Risk] A reset boundary passes between refresh and switch. -> Mitigation: exclude snapshots with a known reset time at or before evaluation time.
- [Risk] A manual target repeatedly remains unhealthy. -> Mitigation: preserve preference, report each fallback reason, and avoid retry loops within one evaluation.

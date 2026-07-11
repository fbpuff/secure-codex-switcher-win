## Context

The current score is a weighted average of two remaining-quota values and two reset-proximity values. A newly reset account therefore receives only the 65 points assigned to remaining quota even when both windows are full. The score is displayed with a percent sign, which incorrectly suggests an official quota percentage.

The current icon is a dark square containing `CS` and a teal footer. It identifies initials but does not express switching accounts, and the letters lose meaning at tray size.

## Goals / Non-Goals

**Goals:**

- Make 100/100 remaining quota produce 100 availability points.
- Penalize the more constrained quota window so one healthy window cannot hide a nearly exhausted one.
- Keep reset times useful without allowing distant resets to subtract from current availability.
- Keep one shared comparator for automatic switching, account ordering, and manual-target fallback.
- Use a text-free icon that remains recognizable at 16, 24, 32, 48, and 256 pixels.

**Non-Goals:**

- User-configurable ranking weights.
- Predicting future token consumption or official quota capacity.
- Changing eligibility, freshness, authentication, or switching safety rules.
- Introducing a new graphics dependency at runtime.

## Decisions

### Decision 1: Bottleneck-aware availability score

Calculate `minimum remaining * 60% + 5h remaining * 20% + 7d remaining * 20%`. This produces 100 for a fully available account and emphasizes whichever quota is closest to exhaustion. If only one remaining value is available, use that value as the score; if neither is available, return 0.

### Decision 2: Reset time is a close-score tie-breaker

Compare availability scores first. When their absolute difference is at most 5 points, prefer the account whose limiting window resets sooner. Continue with greater 7-day remaining, greater 5-hour remaining, nearest known reset, and stable creation order. Reset timing changes selection only for similarly available accounts and never lowers the displayed score.

### Decision 3: Display points, not percent

Show the result as `N points` / `N 分`. The score help explains the bottleneck formula and the close-score reset rule, and continues to show both remaining values and both reset times.

### Decision 4: Text-free switching icon

Use two simplified account silhouettes connected by opposing curved arrows. Retain the product's dark neutral and teal accent, with high-contrast light account shapes. Keep the geometry bold and centered with transparent outer corners so it survives Windows downscaling. Generate source PNG and multi-resolution ICO assets, then rebuild both Windows artifacts.

## Risks / Trade-offs

- [Risk] A 5-point close-score band may change ordering near its boundary. -> Mitigation: cover boundary cases and retain deterministic secondary ordering.
- [Risk] Missing one quota window reduces ranking certainty. -> Mitigation: use the known remaining value and keep existing freshness/eligibility checks.
- [Risk] Windows caches shortcut icons. -> Mitigation: update the shortcut and verify executable and running-process identity after packaging and restart.

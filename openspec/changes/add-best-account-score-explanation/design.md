## Context

The best-score summary currently writes a localized fixed formula into `metricBest.title`. The renderer already imports `scoreBreakdown`, and account details already display the same four components. The missing piece is a discoverable, accessible explanation attached to the summary label.

## Goals / Non-Goals

**Goals:**

- Keep the summary strip's existing proportions and visual hierarchy.
- Make the explanation available to mouse, keyboard, and touch users.
- Show both the stable calculation rules and the current winning account's dynamic values.
- Reuse the shared ranking result and existing translation system.

**Non-Goals:**

- Changing score weights, eligibility, tie-breaking, or automatic switching.
- Making score weights configurable.
- Introducing a tooltip library or a new renderer framework.

## Decisions

### Decision 1: Native button and anchored popover

Use a compact `button` with a familiar question-mark icon and an adjacent popover in the existing metric. CSS handles hover/focus visibility; a small renderer handler controls pinned state, outside click, and Escape. This preserves accessibility and avoids a dependency.

### Decision 2: Shared dynamic breakdown

`renderMetrics` calculates the winning account once and passes it to a focused score-help renderer. Dynamic values come from `scoreBreakdown(best)`. Unknown components remain visibly unknown, matching existing UI semantics.

### Decision 3: Stable layout

The label and help button share one inline header row. The popover is absolutely positioned and constrained to the viewport, so opening it does not resize the summary strip or move neighboring metrics.

## Risks / Trade-offs

- [Risk] The popover can be clipped by a narrow viewport. -> Mitigation: anchor it to the metric edge, cap its width, and switch alignment in the existing responsive breakpoint.
- [Risk] Hover and pinned states can conflict. -> Mitigation: use one explicit pinned class while CSS independently supports hover and focus-within.
- [Risk] Dynamic values may be missing. -> Mitigation: render the localized unknown label and explain weight renormalization.

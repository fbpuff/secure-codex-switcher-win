## Context

Account quota comes from private ChatGPT/Codex usage responses and contains percentage windows plus reset timestamps. Local token totals come from `.codex` rollout events containing `payload.info.last_token_usage`; the current parser deliberately reads only timestamps and token counters. These sources do not share a stable account identifier, and the server does not expose an official token-capacity value.

The app can establish a bounded local correlation by recording which saved account was active during an interval, quota snapshots around that interval, and non-content rollout metadata such as model or reasoning effort when those fields are present. This correlation becomes unreliable when an account is used elsewhere, logs are missing, multiple dimensions are mixed between snapshots, or a quota reset occurs.

The renderer currently has Accounts, Usage, and Settings views. Weekly analysis is a distinct repeated workflow, so it warrants a Reports view between Usage and Settings instead of overloading the existing raw Usage dashboard.

The current launcher invokes the bundled development Electron binary directly. Window title metadata cannot change the executable name shown by Windows; a packaged executable is required.

## Goals / Non-Goals

**Goals:**

- Explain why Switcher quota values can differ from ChatGPT Codex at a given moment.
- Preserve real local token counters while labeling their local-only coverage precisely.
- Attribute observations by account, model, and reasoning effort with explicit confidence rather than false precision.
- Provide useful weekly comparisons, rates, medians, ranges, and sample quality.
- Keep reports local, redacted, bounded in size, and rebuildable from retained observations.
- Make the score explanation fully visible at supported desktop widths.
- Run the production app under a product-named Windows executable.

**Non-Goals:**

- Claiming or discovering an official fixed OpenAI token limit.
- Reading conversation text to infer model or account identity.
- Treating usage from other machines, browsers, or phones as locally attributable.
- Uploading reports, account observations, or session metadata to a remote service.
- Automatically emailing or publishing the weekly report.
- Replacing the existing Accounts or Usage views.

## Decisions

### Decision 1: Keep quota snapshots and local tokens separate

The data model SHALL retain source and timestamp for every quota snapshot and local token observation. UI labels SHALL use `Server quota snapshot` and `Local rollout tokens` equivalents. Capacity values SHALL use `Observed estimate` and include an interval or confidence, never a single official-looking limit.

### Decision 2: Attribute by bounded active-account intervals

Record a redacted account ID reference whenever the Switcher imports, confirms, or switches the active account. Associate local token deltas with an account only when the event timestamp falls inside an unambiguous active interval. Do not infer an account across gaps, unknown startup state, reset boundaries, or conflicting evidence.

Model and reasoning effort SHALL come only from explicit non-content rollout metadata. Unknown values remain `unknown`; they are not filled from current settings after the fact.

### Decision 3: Store deltas, not repeated cumulative totals

Rollout token counters can be cumulative. Normalize them into non-negative deltas per rollout/event and use stable file/event checkpoints so rescans remain idempotent. Record input, cached input, output, reasoning output, total, event count, active duration, and observed wall-clock duration when available.

### Decision 4: Define two rates

- `Token rate` is attributable token delta divided by attributable active duration, with wall-clock rate shown separately when useful.
- `Quota rate` is percentage-point delta divided by elapsed time between valid snapshots.

Never combine these into one unlabeled rate.

### Decision 5: Estimate capacity only from valid samples

An observed capacity sample may be calculated as `attributable token delta / quota percentage-point delta * 100` only when:

- both quota snapshots belong to the same account and same reset window;
- the percentage delta is positive and above the rounding-noise threshold;
- local token attribution covers the full interval;
- the interval does not cross a reset;
- no known external-use or mixed-account evidence exists.

Aggregate samples by plan, account, window, model, and reasoning effort where sample size permits. Prefer median and percentile/range presentation; show mean only alongside sample count and confidence.

### Decision 5a: Detect resets without inventing their cause

Classify a quota recovery as `scheduled` when it aligns with the prior reset boundary. Classify a significant usage-percent decrease before that boundary as `observed_unscheduled` only after account continuity and consecutive-snapshot checks. Use `reset_card` only if the upstream response supplies explicit evidence; otherwise never infer that label. Every detected reset closes the prior observation window and prevents a capacity sample from spanning the reset.

### Decision 6: Dedicated Reports navigation

Add `Reports / 报告` between Usage and Settings. The default report is the latest complete local week. Users can select another retained week and filter account, model, reasoning effort, and confidence. Summary tables remain scannable and do not use nested decorative cards.

### Decision 7: Boundary-aware score popover

Measure the trigger and viewport when opening, choose left/right alignment, and clamp the popover within a fixed viewport gutter. At narrow widths, use a single-column breakdown and a width based on available viewport space. Hover, focus, pinning, Escape, and outside-click behavior remain unchanged.

### Decision 8: Package the Windows app

Choose the smallest packaging tool compatible with the existing Electron project after a dependency and release-artifact check. Set product name, executable name, icon, version metadata, and application user model ID. The launcher SHALL prefer the packaged executable and fail clearly rather than silently falling back to an identity-confusing runtime unless an explicit development mode is requested.

## Privacy And Retention

- Use internal account IDs or existing masked labels; never persist raw email solely for reports.
- Do not read or store conversation bodies.
- Do not copy `auth.json`, access/refresh tokens, API keys, session text, or plugin caches.
- Keep observation/report files under ignored local app data, not the repository.
- Define retention and pruning before implementation; weekly aggregates must not grow without bound.
- Git tests use synthetic accounts and synthetic usage only.

## Measured Implementation Parameters

- Current rollout evidence: recent files provide `turn_context.model` and `turn_context.effort`; observed efforts are `medium`, `high`, and `xhigh`. Token events without context remain supported as unknown.
- Supported production viewport: 920 x 620 minimum, with normal verification at 1120 x 760.
- Week boundary: Monday 00:00 through the following Monday in the user's local timezone.
- Retention: 12 complete weekly reports and at most 90 days of raw observation metadata.
- Capacity threshold: at least 2 percentage points of positive quota consumption inside one unchanged reset window.
- Observed-unscheduled reset threshold: at least 5 percentage points of recovery before the prior reset boundary, confirmed by the next same-account snapshot.
- Aggregate sample rule: show individual samples immediately; show mean/median capacity only with at least 2 valid samples, and mark fewer than 3 samples as low confidence.

## Risks / Trade-offs

- [Risk] External-device usage makes quota deltas larger than local tokens. -> Mitigation: lower confidence or reject the sample; never force attribution.
- [Risk] Percentage rounding makes small samples unstable. -> Mitigation: minimum delta threshold and interval estimates.
- [Risk] A quota recovery could be a reset card, official adjustment, account mismatch, or corrected response. -> Mitigation: report scheduled or observed-unscheduled reset and reserve specific causes for explicit upstream evidence.
- [Risk] Rollout metadata differs across Codex versions. -> Mitigation: tolerant parser, explicit unknown values, fixture coverage for known shapes.
- [Risk] Account interval mapping is ambiguous after manual external login changes. -> Mitigation: require confirmation evidence and mark gaps unattributed.
- [Risk] Packaging adds build complexity. -> Mitigation: one documented Windows packaging path, deterministic output, and a packaged smoke test.
- [Risk] Reports expose sensitive behavioral metadata. -> Mitigation: local-only storage, masking, retention controls, and privacy scans.

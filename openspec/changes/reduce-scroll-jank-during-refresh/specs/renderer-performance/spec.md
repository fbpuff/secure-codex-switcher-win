## ADDED Requirements

### Requirement: Background refresh avoids redundant rendering

The renderer SHALL commit account data once per background refresh cycle and SHALL NOT rebuild unrelated usage or report views for an account-only update.

#### Scenario: Scheduled refresh completes while account view is open

- **WHEN** current and remaining account usage requests finish
- **THEN** account-facing DOM is committed once

### Requirement: Background commits respect active scrolling

The renderer SHALL defer non-urgent background account DOM replacement until the active account-pane scroll interaction has settled.

#### Scenario: User scrolls during refresh completion

- **WHEN** a background refresh becomes ready while either account pane is actively scrolling
- **THEN** the renderer waits for the scroll idle window before committing the update


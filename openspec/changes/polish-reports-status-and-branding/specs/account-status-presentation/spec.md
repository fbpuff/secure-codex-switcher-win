## ADDED Requirements

### Requirement: Immediate state and overall quota are separate
The UI SHALL show whether an account can be used immediately separately from its combined remaining quota and expected recovery.

#### Scenario: 5h is exhausted but 7d remains
- **WHEN** the 5h window is exhausted and the 7d window has remaining quota
- **THEN** the account is shown as waiting for 5h reset while the 7d remaining quota remains visible

### Requirement: Internal branding uses the switch identity
The renderer SHALL use the account-switch product icon treatment instead of a `CS` text monogram.

#### Scenario: Application shell loads
- **WHEN** the main window is displayed
- **THEN** the internal brand mark visually represents account switching and contains no `CS` text

# Design

The account table contains five comparison groups: account, attributed tokens, token composition, usage overview, and attribution confidence. It does not expose quota-change accumulation or reset counts. Reset history remains the only report surface for detected reset events.

The renderer loads `build/icon.png`, which is already part of the packaged application, instead of recreating a separate CSS symbol. The image is decorative and uses fixed dimensions without changing rail geometry.

Reset detection remains window-specific. A 5h boundary does not imply a 7d boundary. Scheduled recovery requires a material used-percent drop at the known boundary; early large drops require a second confirming snapshot before an unscheduled reset is recorded.

# Design

## Immediate availability

An account with either known quota window exhausted is not an immediate switch target. Ready, fresh, non-exhausted accounts are ranked by bottleneck-aware remaining quota. If none is immediately usable, recovery ordering chooses the ready account with the nearest future reset. Recovery does not inflate the displayed immediate availability score.

## Refresh continuity

Capture list and detail scroll offsets plus the selected account before rebuilding account DOM. Restore offsets on the next animation frame after rendering. Preserve disclosure state through stable account identity.

## UI geometry

Use fixed chart row tracks with a dedicated marker line inside the value cell. Account report rows use one six-column CSS grid at desktop widths and paired labeled cells at narrow widths. Model rows keep their semantic labels and center disclosure glyphs using a real icon-style control.

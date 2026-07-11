# Change: Refine account help glyph

## Why

The account-status help control still appears optically off-center and its border becomes indistinct at Windows 125% display scaling because the question mark relies on the button font baseline.

## What Changes

- Render the question mark in a dedicated inner element.
- Give the control stable circular geometry and a clearer border.
- Verify the result in the packaged application at the active Windows DPI.


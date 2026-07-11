# Change: Unify help circle icons

## Why

The summary and account-detail help controls use separate text-glyph implementations. Font rasterization and independent CSS make their circles and question marks appear inconsistent at Windows display scaling.

## What Changes

- Define one reusable vector CircleHelp symbol in the renderer document.
- Reference that symbol from both summary and account-detail help buttons.
- Remove text question marks and glyph-specific positioning.
- Normalize icon sizing, color, and alignment while preserving existing popovers.


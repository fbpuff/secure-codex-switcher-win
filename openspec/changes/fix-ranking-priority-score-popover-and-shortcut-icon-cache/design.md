## Decisions

### Strict score-first ordering

Compare unrounded availability scores first. A higher score always ranks first. Only exact numeric ties compare the limiting-window reset time, then 7-day remaining, 5-hour remaining, nearest reset, and stable creation order.

### Honest decimal display

Display one decimal place, such as `99.2 分`, while quota rings continue to display upstream remaining percentages. Only an actual 100/100 snapshot scores 100.0.

### Structured score help

Use a viewport-clamped width up to 440 pixels. Keep 5h/7d remaining values in two columns. Render each reset label and timestamp as a full-width row with a fixed label track. Switch all breakdown rows to one column on narrow viewports.

### Versioned shortcut icon

Package and retain a versioned icon file named `shortcut-icon-2.5.2.ico`. Recreate the desktop shortcut with that file as `IconLocation`, then call the Windows shell association refresh command. The executable and installer continue using `build/icon.ico`.

## Risks / Trade-offs

- Exact floating-point ties are uncommon. This is intentional: reset time must never reverse a real availability advantage.
- Explorer may retain a stale rendered desktop surface briefly. A new icon path plus shell notification avoids destructive global cache deletion.

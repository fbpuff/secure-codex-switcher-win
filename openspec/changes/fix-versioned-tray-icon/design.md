## Decisions

- Package `tray-icon-2.5.3.png` as an `extraResource` next to the versioned shortcut ICO.
- In packaged mode, construct the tray image only from `process.resourcesPath/tray-icon-2.5.3.png` and resize it to 16 pixels.
- In development mode, use `build/icon.png`.
- Do not call `app.getFileIcon`, because that reintroduces the Windows executable-icon cache.
- Keep the existing `hide()` behavior so minimize-to-tray removes the window from the taskbar.

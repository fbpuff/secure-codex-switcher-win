# Design

## Proxy precedence

Use `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` first. On Windows only, when none is set, read `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` once at startup. Use `ProxyServer` only when `ProxyEnable` is enabled. Normalize protocol-specific proxy strings and keep the existing undici `ProxyAgent`.

## Process traversal

Each ancestor walk owns a visited-PID set and stops before revisiting a PID. This bounds traversal for self-parent records, multi-node cycles, stale parent links, and PID reuse. Process matching includes official executable paths and the `codex-code-mode-host.exe` child while excluding the invoking official Codex tree when applicable.

## Errors

Service errors remain sanitized. Renderer actions strip Electron's `Error invoking remote method` prefix and present the useful localized cause. No raw authorization headers or account identifiers enter diagnostics.

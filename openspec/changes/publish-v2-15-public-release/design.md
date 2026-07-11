## Release Strategy

- Preserve the existing public `main` history.
- Keep the private local `master` history local.
- Create the public release commit by resetting the sanitized final tree onto `origin/main`, producing one reviewable commit with no private local ancestors.
- Push the public commit to `main`, then create tag and release `v2.15.0`.

## Public Assets

- `Secure Codex Switcher-2.15.0-x64.exe`
- `Secure Codex Switcher-2.15.0-x64.exe.blockmap`
- `SHA256SUMS.txt`
- GitHub-generated source archives

## Explicit Exclusions

- `dist/win-unpacked`
- runtime user-data directories
- local account/authentication records
- local Codex session and process-manager data
- development-only screenshots and temporary files


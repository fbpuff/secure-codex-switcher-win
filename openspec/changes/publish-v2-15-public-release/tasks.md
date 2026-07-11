## 1. Documentation And Privacy

- [x] 1.1 Rewrite English README for v2.15.0.
- [x] 1.2 Rewrite matching Chinese README with equivalent sections.
- [x] 1.3 Remove machine-specific paths and personal identifiers from the tracked tree.
- [x] 1.4 Audit tracked files, staged content, commit metadata, and release text for sensitive data.

## 2. Version And Verification

- [x] 2.1 Bump package and lockfile to 2.15.0.
- [x] 2.2 Run full tests, syntax checks, strict OpenSpec validation, and production audit.
- [x] 2.3 Build installer and blockmap and generate SHA-256 checksums.
- [x] 2.4 Inspect ASAR and release assets for private runtime content.

## 3. Public GitHub Publication

- [x] 3.1 Fetch the existing public main branch and verify repository ownership and visibility.
- [x] 3.2 Create one sanitized public commit on top of origin/main without local private history.
- [x] 3.3 Push public main and create tag v2.15.0.
- [x] 3.4 Create bilingual GitHub Release and upload verified assets.
- [x] 3.5 Re-read remote branch, tag, release, and asset metadata after publication.

## 4. Local Completion

- [x] 4.1 Preserve the formal local source and public release branch without runtime secrets.
- [x] 4.2 Restart packaged v2.15.0 and verify one main window without closing active ChatGPT Codex tasks.

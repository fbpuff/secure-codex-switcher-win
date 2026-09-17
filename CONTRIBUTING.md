# Contributing

Read [PRIVACY.md](PRIVACY.md) before making changes or sharing diagnostics.
For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md).

1. Fork the repository and clone your fork.
2. Create a branch for a focused change.
3. On Windows 10 or 11, use Node.js 22.19 or later, npm, and PowerShell 7
   (`pwsh`), which is used by parts of the test suite.
4. Install dependencies and run the existing tests:

   ```powershell
   npm install
   npm test
   ```

5. Make your change, add or update relevant tests when behavior changes, and
   run `npm test` again.
6. Review `git status`, `git diff`, and `git diff --cached` before committing.
   Submit a pull request describing the change and the checks you ran.

Never commit account files, authentication data, logs, tokens, DPAPI blobs,
or runtime data copied from a real user profile. Use synthetic test fixtures;
encryption does not make private data suitable for publication.

See the [README](README.md#development) for development and public build
instructions. Third-party dependencies retain their own licenses and
copyright notices.

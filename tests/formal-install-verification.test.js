import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const verifier = path.join(repoRoot, "scripts", "verify-formal-install.ps1");
const verifierSource = fs.readFileSync(verifier, "utf8");
const sourceRoot = String.raw`E:\Synthetic Workspace\Source`;
const installRoot = String.raw`E:\Synthetic Workspace\Program`;
const userDataPath = String.raw`E:\Synthetic Workspace\Data`;
const executable = path.win32.join(installRoot, "Secure Codex Switcher.exe");
const appAsar = path.win32.join(installRoot, "resources", "app.asar");
const shortcutIcon = path.win32.join(installRoot, "resources", "shortcut-icon-2.5.2.ico");
const uninstaller = path.win32.join(installRoot, "Uninstall Secure Codex Switcher.exe");
const integrationCommit = "a".repeat(40);
const integrationBranch = "codex/complete-branch-integration";

function validSnapshot() {
  return {
    files: {
      executable: true,
      builtAsar: true,
      installedAsar: true,
      sourceBuildIcon: true,
      shortcutIcon: true,
      trayIcon: true,
      uninstaller: true,
    },
    hashes: {
      builtAsar: "ABC123",
      installedAsar: "ABC123",
      sourceBuildIcon: "ICON123",
      installedAsarBuildIcon: "ICON123",
    },
    integrity: {
      executableIconMatchesProductIcon: true,
    },
    provenance: {
      built: { schemaVersion: 1, branch: integrationBranch, commit: integrationCommit },
      installed: { schemaVersion: 1, branch: integrationBranch, commit: integrationCommit },
      source: {
        branch: integrationBranch,
        head: integrationCommit,
        provenanceCommitExists: true,
        provenanceIsAncestor: true,
        releaseTreeMatches: true,
      },
    },
    uninstallCandidates: [
      {
        installLocation: null,
        uninstallString: `"${uninstaller}" /currentuser`,
      },
    ],
    shortcuts: {
      desktop: {
        target: executable,
        workingDirectory: installRoot,
        arguments: `--user-data-dir="${userDataPath}"`,
        iconLocation: `${shortcutIcon},0`,
      },
      startMenu: {
        target: executable,
        workingDirectory: installRoot,
        arguments: `--user-data-dir="${userDataPath}"`,
        iconLocation: `${shortcutIcon},0`,
      },
    },
    processes: [
      {
        processId: 100,
        parentProcessId: 1,
        executablePath: executable,
        commandLine: `"${executable}" "--user-data-dir=${userDataPath}"`,
      },
    ],
  };
}

function verify(snapshot, extraArgs = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-formal-install-"));
  const snapshotPath = path.join(directory, "snapshot.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
  try {
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        verifier,
        "-SourceRoot",
        sourceRoot,
        "-InstallRoot",
        installRoot,
        "-UserDataPath",
        userDataPath,
        "-SnapshotPath",
        snapshotPath,
        ...extraArgs,
      ],
      { encoding: "utf8" },
    );
    let json = null;
    try {
      json = result.stdout ? JSON.parse(result.stdout) : null;
    } catch {}
    return { ...result, json };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("formal verifier rejects missing or relative path parameters before probing an installation", () => {
  assert.doesNotMatch(verifierSource, /\b[A-Z]:\\[A-Za-z]/);
  for (const args of [[], ["-InstallRoot", installRoot, "-UserDataPath", "relative"]]) {
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", verifier, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires an explicit absolute path/);
  }
});

test("accepts a complete formal NSIS installation snapshot", () => {
  const result = verify(validSnapshot(), ["-RequireRunning"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.errors, []);
});

test("rejects a truncated Start Menu shortcut target", () => {
  const snapshot = validSnapshot();
  snapshot.shortcuts.startMenu.target = String.raw`D:\Programs\Secure\Secure Codex Switcher.exe`;

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /shortcut\.startMenu\.target/);
});

test("rejects a win-unpacked materialization without an NSIS uninstaller", () => {
  const snapshot = validSnapshot();
  snapshot.files.uninstaller = false;

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /file\.uninstaller/);
});

test("rejects uninstall metadata outside the complete install root", () => {
  const snapshot = validSnapshot();
  snapshot.uninstallCandidates[0].installLocation = String.raw`D:\Programs\Secure`;

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /registry\.installLocation/);
});

test("rejects uninstall metadata for a different executable", () => {
  const snapshot = validSnapshot();
  snapshot.uninstallCandidates[0].uninstallString = String.raw`"D:\Programs\Secure\Uninstall Secure Codex Switcher.exe" /currentuser`;

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /registry\.uninstallIdentity/);
});

test("rejects duplicate exact formal uninstall identities", () => {
  const snapshot = validSnapshot();
  snapshot.uninstallCandidates.push({ ...snapshot.uninstallCandidates[0] });

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /registry\.uninstallIdentity/);
});

test("rejects mixed valid and invalid uninstall identities", () => {
  const snapshot = validSnapshot();
  snapshot.uninstallCandidates.push({
    installLocation: String.raw`D:\Programs\Secure`,
    uninstallString: String.raw`"D:\Programs\Secure\Uninstall Secure Codex Switcher.exe" /currentuser`,
  });

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /registry\.uninstallIdentity/);
  const error = result.json.errors.find(({ code }) => code === "registry.uninstallIdentity");
  assert.deepEqual(error.actual, { candidateCount: 2, matchingCount: 1 });
});

test("rejects a shortcut with the wrong versioned icon", () => {
  const snapshot = validSnapshot();
  snapshot.shortcuts.desktop.iconLocation = `${installRoot}\\Secure Codex Switcher.exe,0`;

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /shortcut\.desktop\.iconLocation/);
});

test("rejects a shortcut with the wrong user-data argument", () => {
  const snapshot = validSnapshot();
  snapshot.shortcuts.desktop.arguments = String.raw`--user-data-dir="C:\Users\private\AppData\Roaming\switcher"`;

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /shortcut\.desktop\.arguments/);
});

test("rejects a shortcut missing the user-data argument", () => {
  const snapshot = validSnapshot();
  snapshot.shortcuts.startMenu.arguments = "";

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /shortcut\.startMenu\.arguments/);
});

test("rejects a built and installed app.asar hash mismatch", () => {
  const snapshot = validSnapshot();
  snapshot.hashes.installedAsar = "DIFFERENT";

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /hash\.appAsar/);
});

test("rejects built and installed packages with different provenance", () => {
  const snapshot = validSnapshot();
  snapshot.provenance.installed.commit = "b".repeat(40);

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /provenance\.identity/);
});

test("rejects provenance outside the canonical integration branch", () => {
  const snapshot = validSnapshot();
  snapshot.provenance.built.branch = "codex/activity-ui-icon";
  snapshot.provenance.installed.branch = "codex/activity-ui-icon";

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /provenance\.branch/);
});

test("rejects installed provenance that is not represented by the current release tree", () => {
  const snapshot = validSnapshot();
  snapshot.provenance.source.releaseTreeMatches = false;

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /provenance\.source/);
});

test("rejects an installed app.asar whose build/icon.png content differs from source", () => {
  const snapshot = validSnapshot();
  snapshot.hashes.installedAsarBuildIcon = "DIFFERENT";

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /hash\.buildIcon/);
});

test("rejects an installed app.asar without build/icon.png", () => {
  const snapshot = validSnapshot();
  snapshot.hashes.installedAsarBuildIcon = null;

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /hash\.buildIcon/);
});

test("rejects a missing source build/icon.png", () => {
  const snapshot = validSnapshot();
  snapshot.files.sourceBuildIcon = false;
  snapshot.hashes.sourceBuildIcon = null;

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /file\.sourceBuildIcon/);
  assert.match(JSON.stringify(result.json.errors), /hash\.buildIcon/);
});

test("rejects an executable whose associated icon differs from the product icon", () => {
  const snapshot = validSnapshot();
  snapshot.integrity.executableIconMatchesProductIcon = false;

  const result = verify(snapshot);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /icon\.executable/);
});

test("rejects a running Switcher process with the wrong user-data directory", () => {
  const snapshot = validSnapshot();
  snapshot.processes[0].commandLine = `"${executable}" "--user-data-dir=C:\\Users\\private\\AppData\\Roaming\\switcher"`;

  const result = verify(snapshot, ["-RequireRunning"]);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /process\.userData/);
});

test("RequireRunning rejects a snapshot without a root Switcher process", () => {
  const snapshot = validSnapshot();
  snapshot.processes = [
    {
      processId: 101,
      parentProcessId: 100,
      executablePath: executable,
      commandLine: `"${executable}" --type=renderer --user-data-dir="${userDataPath}" --app-path="${appAsar}"`,
    },
  ];

  const result = verify(snapshot, ["-RequireRunning"]);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /process\.root/);
});

test("rejects a renderer loading app.asar outside the formal install", () => {
  const snapshot = validSnapshot();
  snapshot.processes.push({
    processId: 101,
    parentProcessId: 100,
    executablePath: executable,
    commandLine: `"${executable}" --type=renderer --user-data-dir="${userDataPath}" --app-path="${sourceRoot}\\dist\\win-unpacked\\resources\\app.asar"`,
  });

  const result = verify(snapshot, ["-RequireRunning"]);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /process\.appPath/);
});

test("rejects a renderer without an installed app.asar identity", () => {
  const snapshot = validSnapshot();
  snapshot.processes.push({
    processId: 101,
    parentProcessId: 100,
    executablePath: executable,
    commandLine: `"${executable}" --type=renderer --user-data-dir="${userDataPath}"`,
  });

  const result = verify(snapshot, ["-RequireRunning"]);

  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.json.errors), /process\.appPath/);
});

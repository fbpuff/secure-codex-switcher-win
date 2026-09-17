import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const launcher = fs.readFileSync(new URL("../Start-CodexSwitcher.ps1", import.meta.url), "utf8");
const verifier = fs.readFileSync(new URL("../scripts/verify-formal-install.ps1", import.meta.url), "utf8");
const formalPackagerUrl = new URL("../scripts/package-formal.ps1", import.meta.url);
const formalPackager = fs.existsSync(formalPackagerUrl) ? fs.readFileSync(formalPackagerUrl, "utf8") : "";
const versionPolicyVerifierUrl = new URL("../scripts/verify-version-bump.ps1", import.meta.url);

test("Windows package uses Secure Codex Switcher product identity", () => {
  assert.equal(packageJson.productName, "Secure Codex Switcher");
  assert.equal(packageJson.build.appId, "com.securecodexswitcher.windows");
  assert.equal(packageJson.build.win.executableName, "Secure Codex Switcher");
  assert.equal(packageJson.build.asar, true);
  assert.match(packageJson.scripts["package:win"], /package-formal\.ps1/);
  assert.match(main, /app\.setAppUserModelId\("com\.securecodexswitcher\.windows"\)/);
  assert.match(main, /icon:\s*path\.join\(__dirname, "\.\.", "build", "icon\.png"\)/);
  assert.doesNotMatch(main, /createFromDataURL/);
});

test("automatic continuation stays in Codex Desktop so approvals remain interactive", () => {
  assert.match(main, /resumeExecutorMode:\s*"desktop"/);
  assert.doesNotMatch(main, /resumeExecutorMode:\s*"app-server"/);
  assert.match(main, /resumeInterruptedAutoResume\(\)/);
});

test("packaged app initializes selected storage before taking the instance lock", () => {
  assert.match(main, /selectStartupDataPath/);
  assert.match(main, /prepareStartupDataPath\(defaultUserDataPath\)[\s\S]*app\.setPath\("userData", defaultUserDataPath\)[\s\S]*app\.requestSingleInstanceLock/);
  assert.match(main, /app\.commandLine\.hasSwitch\("user-data-dir"\)/);
  assert.match(main, /app\.isPackaged/);
  assert.doesNotMatch(main, /Secure Codex Switcher Data/);
});

test("unrecoverable local account state shows an actionable startup dialog", () => {
  assert.match(main, /dialog\.showErrorBox/);
  assert.match(main, /startupFailureMessage/);
  assert.match(main, /app\.whenReady\(\)[\s\S]*\.catch\(/);
});

test("standard launcher uses packaged executable and development is explicit", () => {
  assert.match(launcher, /Resolve-SwitcherLaunchPaths/);
  assert.match(launcher, /\$env:APPDATA/);
  assert.match(launcher, /--user-data-dir=.*\$userDataPath/);
  assert.doesNotMatch(launcher, /D:\\Programs\\Secure Codex Switcher/);
  assert.match(launcher, /Secure Codex Switcher\.exe/);
  assert.match(launcher, /\$env:LOCALAPPDATA/);
  assert.doesNotMatch(launcher, /C:\\Users|AppData\\Local\\Programs/);
  assert.doesNotMatch(launcher, /dist\\win-unpacked\\Secure Codex Switcher\.exe/);
  assert.doesNotMatch(launcher, /node_modules\\electron/);
  assert.match(launcher, /shortcut-icon-2\.5\.2\.ico/);
  assert.match(launcher, /\[Alias\("user-data-dir"\)\]/);
  assert.match(launcher, /ie4uinit\.exe/);
  assert.equal(fs.existsSync(new URL("../Start-CodexSwitcher-Dev.ps1", import.meta.url)), true);
});

test("formal verifier requires explicit paths and maintained launch files have no fixed drive roots", () => {
  assert.match(verifier, /\[string\]\$InstallRoot,/);
  assert.match(verifier, /\[string\]\$UserDataPath,/);
  assert.match(verifier, /requires an explicit absolute path/);
  for (const content of [main, launcher, verifier]) {
    assert.doesNotMatch(content, /\b[A-Z]:\\[A-Za-z]/);
  }
});

test("formal executable icon verification reads PE resources instead of the shell icon cache", () => {
  assert.match(verifier, /IconGroupEntry\.fromEntries/);
  assert.match(verifier, /NtExecutable\.from/);
  assert.doesNotMatch(verifier, /ExtractAssociatedIcon/);
});

test("formal packaging requires the canonical complete integration lineage and records provenance", () => {
  assert.equal(packageJson.scripts["verify:formal-install"], "pwsh -NoProfile -File scripts/verify-formal-install.ps1");
  assert.match(packageJson.scripts["package:dir"], /package-formal\.ps1[\s\S]*-DirectoryOnly/);
  assert.match(formalPackager, /codex\/complete-branch-integration/);
  for (const head of ["0c0326d", "c25ed94", "300cfe7"]) {
    assert.match(formalPackager, new RegExp(head));
  }
  assert.match(formalPackager, /merge-base[\s\S]*--is-ancestor/);
  assert.match(formalPackager, /status[\s\S]*--porcelain[\s\S]*--untracked-files=all/);
  const versionPolicyIndex = formalPackager.indexOf("verify-version-bump.ps1");
  const provenanceIndex = formalPackager.indexOf("build-provenance.json");
  const builderIndex = formalPackager.indexOf("electron-builder");
  assert.notEqual(versionPolicyIndex, -1);
  assert.equal(fs.existsSync(versionPolicyVerifierUrl), true);
  assert.match(formalPackager, /Test-Path[\s\S]*versionPolicyVerifier/);
  assert.ok(versionPolicyIndex < provenanceIndex);
  assert.ok(versionPolicyIndex < builderIndex);
  for (const marker of [
    "autoSwitchStayAccountId",
    "ignoredStaleTaskCount",
    "manual-switch-inspection",
    "switchAccountPrioritized",
    "orderReportAccounts",
    "quota-auto-switch-action",
  ]) {
    assert.match(formalPackager, new RegExp(marker));
  }
  assert.match(formalPackager, /build-provenance\.json/);
  assert.match(formalPackager, /finally[\s\S]*Remove-Item/);
  assert.match(formalPackager, /electron-builder/);
  assert.match(verifier, /build-provenance\.json/);
});

test("desktop and Start Menu shortcuts are repaired without changing product identity", () => {
  assert.match(launcher, /GetFolderPath\("Desktop"\)/);
  assert.match(launcher, /GetFolderPath\("Programs"\)/);
  assert.match(launcher, /"Codex Switcher\.lnk"/);
  assert.match(launcher, /"Secure Codex Switcher\.lnk"/);
  assert.match(launcher, /foreach\s*\(\$shortcutDirectory\s+in\s+\$shortcutDirectories\)/);
  assert.match(launcher, /Remove-Item\s+-LiteralPath\s+\$retiredShortcut/);
  assert.equal(packageJson.build.nsis.shortcutName, "Codex Switcher");
  assert.equal(packageJson.productName, "Secure Codex Switcher");
  assert.equal(packageJson.build.win.executableName, "Secure Codex Switcher");
});

test("launcher repairs shortcuts before launch and reports each failure separately", () => {
  const repairIndex = launcher.lastIndexOf("Repair-Shortcuts");
  const launchIndex = launcher.indexOf("Start-DetachedSwitcher", repairIndex);
  const launchBody = launcher.slice(launcher.lastIndexOf("try {", launchIndex), launcher.indexOf("} catch", launchIndex));

  assert.notEqual(repairIndex, -1);
  assert.notEqual(launchIndex, -1);
  assert.ok(repairIndex < launchIndex);
  assert.match(launchBody, /Start-DetachedSwitcher/);
  assert.match(launcher, /\(\[wmiclass\]"Win32_Process"\)\.Create\(\$commandLine, \$installedRoot, \$startup\)/);
  assert.match(launcher, /\$startup\.EnvironmentVariables = \[string\[\]\]/);
  assert.doesNotMatch(launcher, /\$startup\.ShowWindow\s*=\s*0/);
  assert.match(launcher, /Error launching Codex Switcher/);
  assert.match(launcher, /Error repairing Codex Switcher shortcuts/);
});

test("package icon assets exist and private runtime files are excluded", () => {
  assert.equal(fs.existsSync(new URL("../build/icon.ico", import.meta.url)), true);
  assert.equal(fs.existsSync(new URL("../build/icon.png", import.meta.url)), true);
  assert.equal(fs.existsSync(new URL("../build/shortcut-icon-2.5.2.ico", import.meta.url)), true);
  assert.match(JSON.stringify(packageJson.build.extraResources), /shortcut-icon-2\.5\.2\.ico/);
  assert.match(fs.readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8"), /\.\.\/\.\.\/build\/icon\.png/);
  const files = JSON.stringify(packageJson.build.files);
  assert.doesNotMatch(files, /auth\.json|accounts-store|usage-observations|sessions|logs/i);
});

test("packaged tray icon bypasses the executable icon cache", () => {
  assert.equal(fs.existsSync(new URL("../build/tray-icon-2.5.3.png", import.meta.url)), true);
  assert.match(JSON.stringify(packageJson.build.extraResources), /tray-icon-2\.5\.3\.png/);
  assert.match(main, /process\.resourcesPath[\s\S]*tray-icon-2\.5\.3\.png/);
  assert.doesNotMatch(main, /app\.getFileIcon/);
  assert.match(main, /mainWindow\.hide\(\)/);
});

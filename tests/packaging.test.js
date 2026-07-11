import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const launcher = fs.readFileSync(new URL("../Start-CodexSwitcher.ps1", import.meta.url), "utf8");

test("Windows package uses Secure Codex Switcher product identity", () => {
  assert.equal(packageJson.productName, "Secure Codex Switcher");
  assert.equal(packageJson.build.appId, "com.securecodexswitcher.windows");
  assert.equal(packageJson.build.win.executableName, "Secure Codex Switcher");
  assert.equal(packageJson.build.asar, true);
  assert.match(packageJson.scripts["package:win"], /electron-builder/);
  assert.match(main, /app\.setAppUserModelId\("com\.securecodexswitcher\.windows"\)/);
  assert.match(main, /icon:\s*path\.join\(__dirname, "\.\.", "build", "icon\.png"\)/);
  assert.doesNotMatch(main, /createFromDataURL/);
});

test("packaging preserves the established user-data path", () => {
  assert.match(main, /app\.setPath\("userData",\s*path\.join\(process\.env\.APPDATA,\s*"secure-codex-switcher-win"\)\)/);
});

test("standard launcher uses packaged executable and development is explicit", () => {
  assert.match(launcher, /dist\\win-unpacked\\Secure Codex Switcher\.exe/);
  assert.doesNotMatch(launcher, /node_modules\\electron/);
  assert.match(launcher, /shortcut-icon-2\.5\.2\.ico/);
  assert.match(launcher, /ie4uinit\.exe/);
  assert.equal(fs.existsSync(new URL("../Start-CodexSwitcher-Dev.ps1", import.meta.url)), true);
});

test("desktop and installer shortcuts use the short label without changing product identity", () => {
  assert.match(launcher, /"Codex Switcher\.lnk"/);
  assert.match(launcher, /"Secure Codex Switcher\.lnk"/);
  assert.match(launcher, /Remove-Item\s+-LiteralPath\s+\$retiredShortcut/);
  assert.equal(packageJson.build.nsis.shortcutName, "Codex Switcher");
  assert.equal(packageJson.productName, "Secure Codex Switcher");
  assert.equal(packageJson.build.win.executableName, "Secure Codex Switcher");
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

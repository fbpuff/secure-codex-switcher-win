import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildOfficialCodexLaunchScript } from "../src/services/account-service.js";

const app = fs.readFileSync(new URL("../src/renderer/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");

test("disable-GPU launch uses native packaged-app activation only when enabled", () => {
  const ordinary = buildOfficialCodexLaunchScript({ disableGpu: false });
  const disabled = buildOfficialCodexLaunchScript({ disableGpu: true });

  assert.match(ordinary, /Start-Process explorer\.exe "shell:AppsFolder\\\$\(\$app\.AppID\)"/);
  assert.doesNotMatch(ordinary, /--disable-gpu/);
  assert.match(disabled, /IApplicationActivationManager/);
  assert.match(disabled, /ActivateApplication/);
  assert.match(disabled, /--disable-gpu/);
  assert.doesNotMatch(disabled, /Start-Process explorer\.exe/);
});

test("disable-GPU settings use narrow IPC actions and localized global and account controls", () => {
  assert.match(main, /"accounts:setDisableGpu": \(_event, accountId, enabled\) => accountService\.setAccountDisableGpuMode\(accountId, Boolean\(enabled\)\)/);
  assert.match(main, /"settings:setDisableGpu": \(_event, enabled\) => accountService\.setDisableGpuMode\(Boolean\(enabled\)\)/);
  assert.match(preload, /setAccountDisableGpuMode: \(accountId, enabled\) => invoke\("accounts:setDisableGpu", accountId, enabled\)/);
  assert.match(preload, /setDisableGpuMode: \(enabled\) => invoke\("settings:setDisableGpu", enabled\)/);
  assert.match(html, /id="settings-disable-gpu"/);
  assert.match(app, /id="detail-disable-gpu"/);
  assert.match(app, /api\.setDisableGpuMode\(requested\)/);
  assert.match(app, /api\.setAccountDisableGpuMode\(account\.id, enabled\)/);
  assert.ok(app.split('"settings.disableGpu"').length >= 3);
  assert.ok(app.split('"detail.accountDisableGpu"').length >= 3);
});

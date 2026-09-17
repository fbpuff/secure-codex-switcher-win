import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectStartupDataPath, prepareStartupDataPath, startupFailureMessage } from "../src/core/startup-storage.js";

const ordinary = { platform: "win32", packaged: true, executablePath: "C:\\Apps\\Switcher\\Secure Codex Switcher.exe", appDataPath: "C:\\Users\\Example\\AppData\\Roaming", exists: () => { throw Error("ordinary install must not probe D drive"); } };
test("ordinary packaged startup does not depend on D drive", () => {
  assert.equal(selectStartupDataPath(ordinary), "C:\\Users\\Example\\AppData\\Roaming\\secure-codex-switcher-win");
});
test("explicit paths with spaces and unicode win, but empty and relative paths fail", () => {
  assert.equal(selectStartupDataPath({ ...ordinary, explicit: '"C:\\用户 数据\\Switcher"' }), "C:\\用户 数据\\Switcher");
  for (const explicit of ["", " ", '""', "relative", "D:relative"]) assert.throws(() => selectStartupDataPath({ ...ordinary, explicit }), /absolute|绝对/);
});
test("relocated installations use AppData unless their existing data is explicitly selected", () => {
  const relocated = { ...ordinary, executablePath: "E:\\Synthetic Workspace\\Program\\Secure Codex Switcher.exe" };
  assert.equal(selectStartupDataPath(relocated), selectStartupDataPath(ordinary));
  assert.equal(selectStartupDataPath({ ...relocated, explicit: "E:\\Synthetic Workspace\\Data" }), "E:\\Synthetic Workspace\\Data");
});
test("directory probe leaves existing data intact and does not leave a probe file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-storage-test-"));
  try {
    fs.writeFileSync(path.join(root,"settings.json"), "fixture");
    prepareStartupDataPath(root);
    assert.deepEqual(fs.readdirSync(root), ["settings.json"]);
    assert.equal(fs.readFileSync(path.join(root,"settings.json"),"utf8"), "fixture");
    const blocked = path.join(root,"settings.json","child");
    assert.throws(() => prepareStartupDataPath(blocked));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test("storage failures are distinct from other startup errors and never expose arbitrary error text", () => {
  assert.match(startupFailureMessage({code:"EACCES"}, "C:\\Example", true), /数据目录无法使用/);
  assert.doesNotMatch(startupFailureMessage(new Error("secret-token"), "C:\\Example", false), /secret-token|数据损坏/);
});

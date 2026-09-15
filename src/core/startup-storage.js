import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function selectStartupDataPath({ platform = process.platform, packaged, executablePath, appDataPath, explicit, exists = fs.existsSync }) {
  const paths = platform === "win32" ? path.win32 : path;
  if (explicit !== undefined) {
    const value = String(explicit).trim().replace(/^"(.*)"$/, "$1");
    if (!value || !paths.isAbsolute(value)) throw new Error("--user-data-dir requires an absolute path / 需要非空绝对路径");
    return paths.normalize(value);
  }
  const legacy = "D:\\Secure Codex Switcher Workspace\\Data";
  if (platform === "win32" && packaged
      && paths.dirname(paths.resolve(executablePath)).toLowerCase() === "d:\\secure codex switcher workspace\\program"
      && ["accounts-store.json", "settings.json"].some(name => exists(paths.join(legacy, name)))) return legacy;
  return paths.join(appDataPath, "secure-codex-switcher-win");
}

export function prepareStartupDataPath(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.startup-write-${randomUUID()}.tmp`);
  let created = false;
  try {
    fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
    created = true;
  } finally {
    if (created) fs.unlinkSync(probe);
  }
}

export function startupFailureMessage(error, directory, storageFailure = false) {
  const code = /^[A-Z][A-Z0-9_]{0,39}$/.test(error?.code || "") ? error.code : "STARTUP_FAILED";
  const heading = storageFailure
    ? "数据目录无法使用 / Data directory unavailable.\n请检查路径、磁盘和写入权限；--user-data-dir 必须是非空绝对路径。"
    : "应用初始化失败 / Application initialization failed.\n请查看启动日志以确定原因；原有账号数据未被自动删除。";
  return `${heading}\n\nDirectory: ${directory || "(not selected)"}\nCode: ${code}`;
}

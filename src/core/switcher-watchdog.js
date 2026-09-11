import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function startSwitcherWatchdog({
  packaged,
  resourcesPath,
  executablePath,
  userDataPath,
  parentProcessId = process.pid,
  spawnImpl = spawn
} = {}) {
  if (!packaged || process.platform !== "win32") return undefined;
  const scriptPath = path.join(resourcesPath, "Watch-SwitcherProcess.ps1");
  if (!fs.existsSync(scriptPath)) return undefined;
  const nonce = crypto.randomUUID();
  const markerPath = path.join(userDataPath, "watchdog-intentional-exit.json");
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const watchdogArgs = [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    "-ParentProcessId", String(parentProcessId), "-Nonce", nonce,
    "-ExecutablePath", executablePath, "-UserDataPath", userDataPath,
    "-IntentMarkerPath", markerPath
  ];
  const argumentLine = watchdogArgs
    .map((value) => `"${String(value).replaceAll('"', '\\"')}"`)
    .join(" ");
  const launchCommand = [
    '$watchdogExecutable = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
    `$watchdogCommandLine = '\"' + $watchdogExecutable + '\" ' + ${quote(argumentLine)}`,
    '$startup = ([wmiclass]"Win32_ProcessStartup").CreateInstance()',
    "$startup.ShowWindow = 0",
    '$result = ([wmiclass]"Win32_Process").Create($watchdogCommandLine, $null, $startup)',
    "if ([int]$result.ReturnValue -ne 0) { exit 1 }"
  ].join("; ");
  const encodedCommand = Buffer.from(launchCommand, "utf16le").toString("base64");
  const child = spawnImpl("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand
  ], { stdio: "ignore", windowsHide: true });
  child.unref?.();
  return { nonce, markerPath };
}

export function markIntentionalSwitcherExit(watchdog) {
  if (!watchdog?.nonce || !watchdog?.markerPath) return false;
  try {
    fs.mkdirSync(path.dirname(watchdog.markerPath), { recursive: true });
    fs.writeFileSync(
      watchdog.markerPath,
      JSON.stringify({ nonce: watchdog.nonce, createdAtMs: Date.now() }),
      { encoding: "utf8", mode: 0o600 }
    );
    return true;
  } catch {
    return false;
  }
}

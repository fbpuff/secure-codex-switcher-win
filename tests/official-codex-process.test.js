import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { officialCodexProcessIds, officialCodexProcessScript } from "../src/core/official-codex-process.js";

const officialPath = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\\app\\Codex.exe";
const chatgptCodexPath = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe";
const officialCliPath = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe";
const switcherPath = "C:\\Users\\TestUser\\AppData\\Local\\Programs\\secure-codex-switcher-win\\Secure Codex Switcher.exe";

test("identifies official Codex processes without matching the switcher", () => {
  const processes = [
    { processId: 10, parentProcessId: 1, name: "Codex.exe", executablePath: officialPath },
    { processId: 11, parentProcessId: 10, name: "codex.exe", executablePath: officialCliPath },
    { processId: 20, parentProcessId: 1, name: "Secure Codex Switcher.exe", executablePath: switcherPath },
    { processId: 21, parentProcessId: 20, name: "Codex.exe", executablePath: switcherPath }
  ];

  assert.deepEqual(officialCodexProcessIds(processes, { currentPid: 20 }), [10, 11]);
});

test("can exclude the current official Codex ancestor tree", () => {
  const processes = [
    { processId: 10, parentProcessId: 1, name: "Codex.exe", executablePath: officialPath },
    { processId: 11, parentProcessId: 10, name: "codex.exe", executablePath: officialCliPath },
    { processId: 12, parentProcessId: 11, name: "node.exe", executablePath: "C:\\runtime\\node.exe" },
    { processId: 13, parentProcessId: 10, name: "Codex.exe", executablePath: officialPath },
    { processId: 30, parentProcessId: 1, name: "Codex.exe", executablePath: officialPath }
  ];

  assert.deepEqual(officialCodexProcessIds(processes, { currentPid: 12, excludeCurrentTree: true }), [30]);
});

test("identifies Codex desktop runtime CLI processes", () => {
  const processes = [
    {
      processId: 40,
      parentProcessId: 20,
      name: "codex.exe",
      executablePath: "C:\\Users\\TestUser\\.codex\\.sandbox-bin\\codex.exe"
    },
    {
      processId: 41,
      parentProcessId: 20,
      name: "codex.exe",
      executablePath: "C:\\Users\\TestUser\\.codex\\plugins\\.plugin-appserver\\codex.exe"
    }
  ];

  assert.deepEqual(officialCodexProcessIds(processes, { currentPid: 20 }), [40, 41]);
});

test("identifies the ChatGPT Codex desktop process without matching unrelated ChatGPT", () => {
  const processes = [
    { processId: 50, parentProcessId: 1, name: "ChatGPT.exe", executablePath: chatgptCodexPath },
    { processId: 51, parentProcessId: 50, name: "codex.exe", executablePath: officialCliPath },
    { processId: 52, parentProcessId: 1, name: "ChatGPT.exe", executablePath: "C:\\Tools\\ChatGPT.exe" }
  ];

  assert.deepEqual(officialCodexProcessIds(processes, { currentPid: 20 }), [50, 51]);
});

test("terminates traversal when unrelated process metadata contains cycles", () => {
  const processes = [
    { processId: 60, parentProcessId: 60, name: "steam.exe", executablePath: "C:\\Steam\\steam.exe" },
    { processId: 61, parentProcessId: 62, name: "helper.exe", executablePath: "C:\\Tools\\helper.exe" },
    { processId: 62, parentProcessId: 61, name: "helper.exe", executablePath: "C:\\Tools\\helper.exe" },
    { processId: 70, parentProcessId: 1, name: "ChatGPT.exe", executablePath: chatgptCodexPath }
  ];
  assert.deepEqual(officialCodexProcessIds(processes, { currentPid: 999, excludeCurrentTree: true }), [70]);
});

test("identifies the packaged code mode host only from official paths", () => {
  const processes = [
    { processId: 80, parentProcessId: 70, name: "codex-code-mode-host.exe", executablePath: officialCliPath.replace("codex.exe", "codex-code-mode-host.exe") },
    { processId: 81, parentProcessId: 1, name: "codex-code-mode-host.exe", executablePath: "C:\\Tools\\codex-code-mode-host.exe" }
  ];
  assert.deepEqual(officialCodexProcessIds(processes, { currentPid: 999 }), [80]);
});

test("production process script does not exclude a ChatGPT ancestor tree", () => {
  const script = officialCodexProcessScript({ mode: "close", currentPid: 123 });
  assert.doesNotMatch(script, /\$excluded = CurrentOfficialCodexTreeIds/);
  assert.match(script, /\$excluded = New-Object System\.Collections\.Generic\.HashSet\[int\]/);
});

test("diagnostic process script can explicitly exclude a current official ancestor tree", () => {
  const script = officialCodexProcessScript({ mode: "count", currentPid: 123, excludeCurrentTree: true });
  assert.match(script, /\$excluded = CurrentOfficialCodexTreeIds/);
});

test("activity inspection uses a mandatory WMI snapshot and reports app-server count", () => {
  const script = officialCodexProcessScript({ mode: "inspect", currentPid: 123 });

  assert.equal(script.match(/Get-CimInstance Win32_Process/g)?.length, 1);
  assert.match(script, /\$all = @\(Get-CimInstance Win32_Process -ErrorAction Stop\)/);
  assert.match(script, /appServerCount/);
  assert.match(script, /latestAppServerStartMs/);
  assert.match(script, /processIds/);
  assert.match(script, /ConvertTo-Json -Compress/);
});

test("activity inspection propagates a WMI enumeration failure", { skip: process.platform !== "win32" }, () => {
  const script = officialCodexProcessScript({ mode: "inspect", currentPid: 123 })
    .replace("$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)", "throw 'WMI unavailable'");

  assert.throws(
    () => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }),
    (error) => {
      assert.match(String(error.stderr), /WMI unavailable/);
      return true;
    }
  );
});

test("activity inspection ignores a later helper when reporting the app-server start", { skip: process.platform !== "win32" }, () => {
  const appServerStart = "2026-07-16T08:00:00.000000+000";
  const helperStart = "2026-07-16T08:05:00.000000+000";
  const value = runInspectionWithProcesses([
    {
      ProcessId: 200,
      ParentProcessId: 100,
      Name: "codex.exe",
      ExecutablePath: officialCliPath,
      CommandLine: `"${officialCliPath}" app-server --analytics-default-enabled`,
      CreationDate: appServerStart
    },
    {
      ProcessId: 201,
      ParentProcessId: 100,
      Name: "codex-code-mode-host.exe",
      ExecutablePath: officialCliPath.replace("codex.exe", "codex-code-mode-host.exe"),
      CommandLine: `"${officialCliPath}" app-server-helper`,
      CreationDate: helperStart
    },
    {
      ProcessId: 202,
      ParentProcessId: 100,
      Name: "codex.exe",
      ExecutablePath: officialCliPath,
      CommandLine: `"${officialCliPath}" app-server-helper`,
      CreationDate: helperStart
    }
  ]);

  assert.equal(value.count, 3);
  assert.equal(value.appServerCount, 1);
  assert.equal(value.latestAppServerStartMs, Date.parse("2026-07-16T08:00:00.000Z"));
});

test("activity inspection preserves app-server multiplicity", { skip: process.platform !== "win32" }, () => {
  const olderStart = "2026-07-16T08:00:00.000000+000";
  const newerStart = "2026-07-16T08:05:00.000000+000";
  const value = runInspectionWithProcesses([
    {
      ProcessId: 210,
      ParentProcessId: 100,
      Name: "codex.exe",
      ExecutablePath: officialCliPath,
      CommandLine: `"${officialCliPath}" app-server --analytics-default-enabled`,
      CreationDate: olderStart
    },
    {
      ProcessId: 211,
      ParentProcessId: 101,
      Name: "codex.exe",
      ExecutablePath: officialCliPath,
      CommandLine: `"${officialCliPath}" app-server --analytics-default-enabled`,
      CreationDate: newerStart
    }
  ]);

  assert.equal(value.count, 2);
  assert.equal(value.appServerCount, 2);
  assert.equal(value.latestAppServerStartMs, Date.parse("2026-07-16T08:05:00.000Z"));
});

test("activity inspection omits app-server start when only helpers are running", { skip: process.platform !== "win32" }, () => {
  const value = runInspectionWithProcesses([
    {
      ProcessId: 201,
      ParentProcessId: 100,
      Name: "codex-code-mode-host.exe",
      ExecutablePath: officialCliPath.replace("codex.exe", "codex-code-mode-host.exe"),
      CommandLine: `"${officialCliPath}" app-server-helper`,
      CreationDate: "2026-07-16T08:05:00.000000+000"
    }
  ]);

  assert.equal(value.count, 1);
  assert.equal(value.latestAppServerStartMs, null);
});

function runInspectionWithProcesses(processes) {
  const script = officialCodexProcessScript({ mode: "inspect", currentPid: 123 })
    .replace(
      /\$all = @\(Get-CimInstance Win32_Process -ErrorAction (?:SilentlyContinue|Stop)\)/,
      `$all = @(ConvertFrom-Json '${JSON.stringify(processes).replaceAll("'", "''")}' | ForEach-Object { $_ })`
    );
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true
  }));
}

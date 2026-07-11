import assert from "node:assert/strict";
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

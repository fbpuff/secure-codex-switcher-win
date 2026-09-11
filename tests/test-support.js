import path from "node:path";
import { createAccountService as createProductionAccountService } from "../src/services/account-service.js";

export function createTestAccountService(userDataPath, options = {}) {
  return createProductionAccountService(userDataPath, {
    closeCodexProcesses: () => {
      throw new Error("test isolation: real Codex process closure is disabled");
    },
    launchCodex: () => {
      throw new Error("test isolation: real Codex launch is disabled");
    },
    countCodexProcesses: () => 0,
    getCodexThreadIntegritySnapshot: () => ({ revision: "test-stable" }),
    codexLaunchRetryDelaysMs: [],
    createCriticalCodexSnapshot: () => undefined,
    codexDir: path.join(userDataPath, ".codex-test"),
    ...options
  });
}

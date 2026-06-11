#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { createAccountService } from "./services/account-service.js";
import { createProxyAwareFetch } from "./core/proxy-fetch.js";

const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
const service = createAccountService(path.join(appData, "secure-codex-switcher-win"), { fetchImpl: createProxyAwareFetch(fetch) });
const [command, ...args] = process.argv.slice(2);

const commands = {
  async list() {
    printJson(service.listAccounts());
  },
  async "import-current"() {
    printJson(service.importCurrentAuth());
  },
  async refresh() {
    const [accountId] = args;
    requireArg(accountId, "account id");
    printJson(await service.refreshUsage(accountId, true));
  },
  async "refresh-all"() {
    printJson(await service.refreshAllUsage());
  },
  async best() {
    printJson(service.pickBestAccount());
  },
  async switch() {
    const [accountId] = args;
    requireArg(accountId, "account id");
    printJson(service.switchAccount(accountId));
  },
  async delete() {
    const [accountId, replacementAccountId] = args;
    requireArg(accountId, "account id");
    printJson(service.deleteAccount(accountId, replacementAccountId));
  },
  async settings() {
    const [key, value] = args;
    if (!key) {
      printJson(service.readSettings());
      return;
    }
    if (!["autoSwitchEnabled", "requireSwitchConfirmation"].includes(key)) {
      throw new Error("Allowed settings: autoSwitchEnabled, requireSwitchConfirmation");
    }
    printJson(service.updateSettings({ [key]: value === "true" }));
  },
  async help() {
    console.log(`Secure Codex Switcher CLI

Commands:
  list
  import-current
  refresh <account-id>
  refresh-all
  best
  switch <account-id>
  delete <account-id> [replacement-account-id]
  settings [autoSwitchEnabled|requireSwitchConfirmation] [true|false]
`);
  }
};

try {
  await (commands[command] ?? commands.help)();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function requireArg(value, label) {
  if (!value) {
    throw new Error(`Missing ${label}.`);
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

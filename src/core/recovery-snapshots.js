import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { protectString, unprotectString } from "./dpapi.js";
import { atomicWriteText } from "./file-io.js";

const SNAPSHOT_PATTERN = /^switcher-state\.(\d{13})\.([a-f0-9]{64})\.json\.dpapi$/;

export function saveRecoverySnapshot(snapshotDir, store, settings, limit = 10) {
  const payload = recoveryPayload(store, settings);
  if (payload.store.accounts.length === 0) return undefined;

  const plainText = JSON.stringify(payload);
  const fingerprint = crypto.createHash("sha256").update(plainText).digest("hex");
  const existing = listSnapshots(snapshotDir);
  if (existing.some((item) => item.fingerprint === fingerprint)) return undefined;

  fs.mkdirSync(snapshotDir, { recursive: true });
  const latestTimestamp = existing.reduce((maximum, item) => Math.max(maximum, item.timestamp), 0);
  const timestamp = Math.max(Date.now(), latestTimestamp + 1);
  const target = path.join(snapshotDir, `switcher-state.${timestamp}.${fingerprint}.json.dpapi`);
  atomicWriteText(target, `${protectString(plainText)}\n`);

  const snapshots = listSnapshots(snapshotDir);
  for (const extra of snapshots.slice(0, Math.max(0, snapshots.length - limit))) {
    fs.rmSync(extra.path, { force: true });
  }
  return target;
}

export function loadLatestValidRecoverySnapshot(snapshotDir) {
  for (const snapshot of listSnapshots(snapshotDir).reverse()) {
    try {
      const payload = JSON.parse(unprotectString(fs.readFileSync(snapshot.path, "utf8")));
      if (!isRecoveryPayload(payload)) continue;
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      if (fingerprint !== snapshot.fingerprint) continue;
      return payload;
    } catch {}
  }
  return undefined;
}

function recoveryPayload(store, settings) {
  return {
    version: 1,
    store: {
      version: Number(store?.version) || 1,
      accounts: Array.isArray(store?.accounts) ? store.accounts.map(recoveryAccount) : []
    },
    settings
  };
}

function recoveryAccount(account) {
  const recoverable = {
    id: account.id,
    accountId: account.accountId,
    emailMasked: account.emailMasked,
    planType: account.planType,
    encryptedAuth: account.encryptedAuth,
    fingerprint: account.fingerprint,
    status: "ready",
    createdAt: account.createdAt
  };
  if (typeof account.httpOnlyModeEnabled === "boolean") {
    recoverable.httpOnlyModeEnabled = account.httpOnlyModeEnabled;
  }
  if (typeof account.disableGpuModeEnabled === "boolean") {
    recoverable.disableGpuModeEnabled = account.disableGpuModeEnabled;
  }
  if (typeof account.encryptedRemark === "string" && account.encryptedRemark) {
    recoverable.encryptedRemark = account.encryptedRemark;
  }
  return recoverable;
}

function isRecoveryPayload(payload) {
  return (
    payload?.version === 1 &&
    payload.store?.version === 1 &&
    Array.isArray(payload.store.accounts) &&
    payload.store.accounts.every(
      (account) => account && typeof account.id === "string" && typeof account.encryptedAuth === "string"
    ) &&
    payload.settings &&
    typeof payload.settings === "object" &&
    !Array.isArray(payload.settings)
  );
}

function listSnapshots(snapshotDir) {
  if (!fs.existsSync(snapshotDir)) return [];
  return fs
    .readdirSync(snapshotDir)
    .map((name) => {
      const match = name.match(SNAPSHOT_PATTERN);
      return match
        ? { path: path.join(snapshotDir, name), timestamp: Number(match[1]), fingerprint: match[2] }
        : undefined;
    })
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
}

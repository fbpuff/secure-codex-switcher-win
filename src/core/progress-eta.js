const ETA_STAGES = new Set(["processing", "validating", "validating_backup", "comparing_live"]);
const WARMUP_MS = 10_000;
const STALL_MS = 15_000;

export function createProgressEtaEstimator() {
  let stage;
  let stageStartedAt;
  let lastProgressAt;
  let samples = [];

  return {
    reset() {
      stage = undefined;
      stageStartedAt = undefined;
      lastProgressAt = undefined;
      samples = [];
    },
    update(progress, nowMs, operationStartedAt) {
      if (!ETA_STAGES.has(progress?.stage) || !Number.isFinite(progress.processedBytes) || !Number.isFinite(progress.totalBytes)) return undefined;
      if (progress.stage !== stage) {
        stage = progress.stage;
        stageStartedAt = nowMs;
        lastProgressAt = nowMs;
        samples = [{ at: nowMs, bytes: progress.processedBytes }];
      } else if (progress.processedBytes > samples.at(-1).bytes) {
        samples.push({ at: nowMs, bytes: progress.processedBytes });
        samples = samples.slice(-6);
        lastProgressAt = nowMs;
      }
      if (nowMs - stageStartedAt < WARMUP_MS || nowMs - lastProgressAt > STALL_MS || samples.length < 2) return undefined;
      const first = samples[0];
      const last = samples.at(-1);
      const bytesPerMs = (last.bytes - first.bytes) / (last.at - first.at);
      if (!(bytesPerMs > 0)) return undefined;
      return Math.max(0, Math.ceil(((progress.totalBytes - progress.processedBytes) / bytesPerMs) / 60_000));
    }
  };
}

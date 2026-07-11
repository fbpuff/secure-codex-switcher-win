import fs from "node:fs";
import path from "node:path";
import { latestMatchingFiles } from "./file-io.js";

const MAX_SESSION_FILES = 8;

export function inspectCodexTaskActivity(codexDir, cache = new Map()) {
  const files = latestMatchingFiles(path.join(codexDir, "sessions"), /^rollout-.*\.jsonl$/)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_SESSION_FILES);
  let uncertain = false;
  let observedLifecycle = false;

  for (const file of files) {
    const previous = cache.get(file.path);
    const state = previous && previous.offset <= file.size
      ? previous
      : { offset: 0, remainder: Buffer.alloc(0), active: false, observedLifecycle: false };
    if (file.size > state.offset) {
      const length = file.size - state.offset;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(file.path, "r");
      try {
        fs.readSync(fd, buffer, 0, length, state.offset);
      } finally {
        fs.closeSync(fd);
      }
      const combined = Buffer.concat([state.remainder, buffer]);
      const lastNewline = combined.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        const complete = combined.subarray(0, lastNewline).toString("utf8");
        state.remainder = combined.subarray(lastNewline + 1);
        for (const line of complete.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const type = event?.type === "event_msg" ? event?.payload?.type : undefined;
            if (type === "task_started") {
              state.active = true;
              state.observedLifecycle = true;
            } else if (type === "task_complete") {
              state.active = false;
              state.observedLifecycle = true;
            }
          } catch {
            uncertain = true;
          }
        }
      } else {
        state.remainder = combined;
      }
      state.offset = file.size;
      cache.set(file.path, state);
    }
    observedLifecycle ||= state.observedLifecycle;
    if (state.active) {
      return { isBusy: true, isUncertain: false, reason: "active_task_lifecycle" };
    }
  }

  if (uncertain) {
    return { isBusy: true, isUncertain: true, reason: "task_lifecycle_uncertain" };
  }
  return {
    isBusy: false,
    isUncertain: false,
    reason: observedLifecycle ? "task_lifecycle_complete" : "task_lifecycle_unavailable"
  };
}

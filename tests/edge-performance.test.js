import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import * as geometry from "../src/core/edge-window.js";
import * as lifecycle from "../src/core/edge-window-lifecycle.js";

test("native handle correction anchors actual client edges and avoids repeated moves", () => {
  let bounds = { x: 2536, y: 100, width: 32, height: 72 };
  let calls = 0;
  const target = {
    getBounds: () => ({ ...bounds }),
    getContentBounds: () => ({ ...bounds }),
    setBounds: (next) => { calls++; bounds = { ...next, width: Math.max(32, next.width) }; }
  };
  const requested = { x: 2536, y: 100, width: 24, height: 72 };
  geometry.positionEdgeHandle(target, requested, "right");
  assert.equal(bounds.x + bounds.width, 2560);
  for (let i = 0; i < 20; i++) geometry.positionEdgeHandle(target, requested, "right");
  assert.equal(calls, 1);
  geometry.positionEdgeHandle(target, { ...requested, x: 0 }, "left");
  assert.equal(bounds.x, 0);
  assert.equal(bounds.width, 32);
});

test("handle positioning respects client insets on negative-coordinate displays", () => {
  let bounds = { x: -24, y: 120, width: 32, height: 80 };
  const target = {
    getBounds: () => ({ ...bounds }),
    getContentBounds: () => ({ x: bounds.x + 4, y: bounds.y + 4, width: 24, height: 72 }),
    setBounds: (next) => { bounds = { ...next, width: 32, height: 80 }; }
  };
  geometry.positionEdgeHandle(target, { x: -24, y: 120, width: 24, height: 72 }, "right");
  assert.equal(target.getContentBounds().x + target.getContentBounds().width, 0);
  assert.equal(target.getContentBounds().y, 120);
  geometry.positionEdgeHandle(target, { x: -1920, y: 300, width: 24, height: 72 }, "left");
  assert.equal(target.getContentBounds().x, -1920);
  assert.equal(target.getContentBounds().y, 300);
});

test("side changes update the hash without reloading an existing renderer", async () => {
  const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const source = main.slice(main.indexOf("function setEdgeHandleSide"), main.indexOf("function createEdgeHandleWindow"));
  let reloads = 0;
  let script = "";
  const target = { webContents: { isLoading: () => false, executeJavaScript: async (value) => { script = value; } }, loadFile: async () => { reloads++; } };
  const context = { edgeHandleSide: "right", edgeHandleWindow: target, target, path, __dirname: "test", recordEdgeLifecycle() {} };
  vm.runInNewContext(source + '\nsetEdgeHandleSide(target, "left");', context);
  await Promise.resolve();
  assert.equal(reloads, 0);
  assert.match(script, /location\.hash/);
  assert.match(script, /left/);
});

test("fractional DPI correction never feeds enlarged native sizes back into Windows", () => {
  let bounds = { x: 1683, y: 100, width: 30, height: 74 };
  let calls = 0;
  const target = {
    getBounds: () => ({ ...bounds }), getContentBounds: () => ({ ...bounds }),
    setBounds: (next) => {
      calls++;
      assert.equal(next.width, 24);
      assert.equal(next.height, 72);
      bounds = { ...next, width: 27 };
    }
  };
  const requested = { x: 1683, y: 100, width: 24, height: 72 };
  geometry.positionEdgeHandle(target, requested, "right");
  assert.equal(bounds.x + bounds.width, 1707);
  assert.equal(bounds.width, 27);
  assert.equal(calls, 2);
  assert.equal(geometry.positionEdgeHandle(target, requested, "right"), false);
});

test("async lifecycle writer is ordered, bounded and reports write failures", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-async-test-"));
  try {
    const file = path.join(dir, "events.jsonl");
    const writer = lifecycle.createEdgeLifecycleWriter(file);
    for (let i = 0; i < 600; i++) writer.append(lifecycle.createEdgeWindowLifecycleRecord({ event: "move_settled", reasonCode: "move_" + i }));
    assert.equal(await writer.flush(), true);
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.trim().split("\n").map(JSON.parse);
    assert.ok(lines.length <= lifecycle.EDGE_WINDOW_LIFECYCLE_MAX_RECORDS);
    assert.ok(Buffer.byteLength(raw) <= lifecycle.EDGE_WINDOW_LIFECYCLE_MAX_BYTES);
    assert.equal(lines.at(-1).reason, "move_599");
    const bad = lifecycle.createEdgeLifecycleWriter(dir);
    bad.append({ event: "test" });
    assert.equal(await bad.flush(), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("collapsed pointer sampling has no disk reads or native positioning", () => {
  const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const watcher = main.slice(main.indexOf("function startEdgePointerWatcher"), main.indexOf("function stopEdgePointerWatcher"));
  assert.doesNotMatch(watcher, /readSettings|setBounds|createEdgeHandleWindow|edgeProjection/);
  assert.match(watcher, /getContentBounds/);
  assert.match(watcher, /scheduleEdgeHandleRecovery/);
});

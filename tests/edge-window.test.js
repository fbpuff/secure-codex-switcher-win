import assert from "node:assert/strict";
import test from "node:test";
import {
  collapsedEdgeBounds,
  edgePlacementUpdate,
  detectEdgeDock,
  EDGE_HANDLE_VISIBLE_WIDTH,
  EDGE_HANDLE_WINDOW_WIDTH,
  EDGE_WINDOW_MIN_HEIGHT,
  EDGE_WINDOW_MIN_WIDTH,
  isDockEdgeExposed,
  isPointerNearEdgeMarker,
  isRevealHandleHit,
  normalizeEdgeWindowSize,
  restoredEdgeBounds,
  shownEdgeBounds
} from "../src/core/edge-window.js";

const workArea = { x: 1920, y: 40, width: 1920, height: 1040 };

test("detects only left and right work-area edge docking", () => {
  assert.equal(detectEdgeDock(workArea, { x: 1928, y: 100, width: 450, height: 610 }, 16), "left");
  assert.equal(detectEdgeDock(workArea, { x: 3382, y: 100, width: 450, height: 610 }, 16), "right");
  assert.equal(detectEdgeDock(workArea, { x: 2400, y: 40, width: 450, height: 610 }, 16), undefined);
});

test("accepts only a deliberate mouse release close to the display edge", () => {
  assert.equal(detectEdgeDock(workArea, { x: 1948, y: 100, width: 450, height: 610 }), "left");
  assert.equal(detectEdgeDock(workArea, { x: 3362, y: 100, width: 450, height: 610 }), "right");
  assert.equal(detectEdgeDock(workArea, { x: 1956, y: 100, width: 450, height: 610 }), undefined);
});

test("accepts a mouse release after the window crosses an edge but remains visible", () => {
  assert.equal(detectEdgeDock(workArea, { x: 1580, y: 100, width: 450, height: 610 }), "left");
  assert.equal(detectEdgeDock(workArea, { x: 3810, y: 100, width: 450, height: 610 }), "right");
  assert.equal(detectEdgeDock(workArea, { x: 1400, y: 100, width: 450, height: 610 }), undefined);
  assert.equal(detectEdgeDock(workArea, { x: 3840, y: 100, width: 450, height: 610 }), undefined);
});

test("does not magnetize at an internal seam between adjacent displays", () => {
  const leftDisplay = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const rightDisplay = { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const displays = [leftDisplay, rightDisplay];

  assert.equal(isDockEdgeExposed(leftDisplay, displays, "right", { x: 1500, y: 100, width: 450, height: 610 }), false);
  assert.equal(isDockEdgeExposed(rightDisplay, displays, "left", { x: 1900, y: 100, width: 450, height: 610 }), false);
  assert.equal(isDockEdgeExposed(leftDisplay, displays, "left", { x: 0, y: 100, width: 450, height: 610 }), true);
  assert.equal(isDockEdgeExposed(rightDisplay, displays, "right", { x: 3390, y: 100, width: 450, height: 610 }), true);
});

test("shown bounds clamp vertical placement inside the selected display work area", () => {
  assert.deepEqual(shownEdgeBounds(workArea, { width: 450, height: 610 }, "right", -50), {
    x: 3390,
    y: 40,
    width: 450,
    height: 610
  });
  assert.deepEqual(shownEdgeBounds(workArea, { width: 450, height: 610 }, "left", 9999), {
    x: 1920,
    y: 1008,
    width: 450,
    height: 610
  });
});

test("edge window sizes never shrink below the responsive layout floor", () => {
  assert.deepEqual(normalizeEdgeWindowSize({ width: 120, height: 90 }), {
    width: EDGE_WINDOW_MIN_WIDTH,
    height: EDGE_WINDOW_MIN_HEIGHT
  });
  assert.deepEqual(shownEdgeBounds(workArea, { width: 120, height: 90 }, "right", 100), {
    x: 3480,
    y: 100,
    width: EDGE_WINDOW_MIN_WIDTH,
    height: EDGE_WINDOW_MIN_HEIGHT
  });
});

test("collapsed bounds keep the native handle container inside either edge", () => {
  const shown = shownEdgeBounds(workArea, { width: 420, height: 470 }, "right", 100);
  assert.equal(EDGE_HANDLE_VISIBLE_WIDTH, 12);
  assert.deepEqual(collapsedEdgeBounds(workArea, shown, "right"), {
    x: workArea.x + workArea.width - EDGE_HANDLE_WINDOW_WIDTH,
    y: 299,
    width: EDGE_HANDLE_WINDOW_WIDTH,
    height: 72
  });
  assert.deepEqual(collapsedEdgeBounds(workArea, { ...shown, x: 1920 }, "left"), {
    x: 1920,
    y: 299,
    width: EDGE_HANDLE_WINDOW_WIDTH,
    height: 72
  });
});

test("pointer proximity is limited to the marker on its docked edge", () => {
  const marker = {
    x: workArea.x + workArea.width - EDGE_HANDLE_WINDOW_WIDTH,
    y: 299,
    width: EDGE_HANDLE_WINDOW_WIDTH,
    height: 72
  };
  assert.equal(isPointerNearEdgeMarker(workArea, marker, "right", { x: 3839, y: 335 }), true);
  assert.equal(isPointerNearEdgeMarker(workArea, marker, "right", { x: 1921, y: 335 }), false);
  assert.equal(isPointerNearEdgeMarker(workArea, marker, "right", { x: 3839, y: 450 }), false);
  assert.equal(isPointerNearEdgeMarker(workArea, { ...marker, x: 1920 }, "left", { x: 1921, y: 335 }), true);
});

test("reveal handle accepts only the centered vertical strip", () => {
  assert.equal(isRevealHandleHit(610, 305), true);
  assert.equal(isRevealHandleHit(610, 341), true);
  assert.equal(isRevealHandleHit(610, 342), false);
  assert.equal(isRevealHandleHit(610, Number.NaN), false);
});


test("floating placement preserves free coordinates and clamps restored bounds", () => {
  const moved = edgePlacementUpdate({
    displayId: 2,
    workArea,
    bounds: { x: 2500, y: 220, width: 505, height: 640 },
    kind: "move",
    currentSize: { width: 420, height: 470 }
  });
  assert.deepEqual(moved.bounds, { x: 2500, y: 220, width: 420, height: 470 });
  assert.deepEqual(moved.settings, {
    edgeWindowDisplayId: "2",
    edgeWindowDocked: false,
    edgeWindowX: 2500,
    edgeWindowY: 220
  });
  assert.deepEqual(restoredEdgeBounds(workArea, { width: 420, height: 470 }, {
    docked: false,
    x: 3900,
    y: 900,
    side: "right"
  }), { x: 3420, y: 900, width: 420, height: 470 });
});

test("move persistence retains the expanded size while resize persistence updates it", () => {
  const currentSize = { width: 420, height: 470 };
  const moved = edgePlacementUpdate({
    displayId: 2,
    workArea,
    bounds: { x: 1928, y: 180, width: 505, height: 640 },
    side: "left",
    kind: "move",
    currentSize
  });
  assert.deepEqual(moved.bounds, { x: 1920, y: 180, width: 420, height: 470 });
  assert.deepEqual(moved.settings, {
    edgeWindowDisplayId: "2",
    edgeWindowDocked: true,
    edgeWindowDockSide: "left",
    edgeWindowY: 180
  });

  const resized = edgePlacementUpdate({
    displayId: 2,
    workArea,
    bounds: { x: 3335, y: 180, width: 505, height: 640 },
    side: "right",
    kind: "resize",
    currentSize
  });
  assert.deepEqual(resized.bounds, { x: 3335, y: 180, width: 505, height: 640 });
  assert.deepEqual(resized.settings, {
    edgeWindowDisplayId: "2",
    edgeWindowDocked: true,
    edgeWindowDockSide: "right",
    edgeWindowY: 180,
    edgeWindowWidth: 505,
    edgeWindowHeight: 640
  });

  const undersized = edgePlacementUpdate({
    displayId: 2,
    workArea,
    bounds: { x: 3700, y: 180, width: 140, height: 120 },
    side: "right",
    kind: "resize",
    currentSize
  });
  assert.deepEqual(undersized.bounds, { x: 3480, y: 180, width: 360, height: 400 });
  assert.equal(undersized.settings.edgeWindowWidth, EDGE_WINDOW_MIN_WIDTH);
  assert.equal(undersized.settings.edgeWindowHeight, EDGE_WINDOW_MIN_HEIGHT);
});

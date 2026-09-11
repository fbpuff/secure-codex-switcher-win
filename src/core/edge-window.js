export const EDGE_WINDOW_WIDTH = 420;
export const EDGE_WINDOW_HEIGHT = 470;
export const EDGE_WINDOW_MIN_WIDTH = 360;
export const EDGE_WINDOW_MIN_HEIGHT = 400;
export const EDGE_HANDLE_VISIBLE_WIDTH = 12;
export const EDGE_HANDLE_WINDOW_WIDTH = 24;
export const EDGE_HANDLE_HEIGHT = 72;
// Dock only when the window is deliberately dragged to the display edge.
export const EDGE_SNAP_THRESHOLD = 32;

export function sameEdgeBounds(left, right) {
  return ["x", "y", "width", "height"].every((key) => left?.[key] === right?.[key]);
}

// Windows may enforce a larger native minimum than the requested handle width.
// Anchor the client edge, where the strip is painted, instead of the request.
export function positionEdgeHandle(target, requested, side) {
  let changed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = target.getBounds();
    const content = target.getContentBounds();
    const x = side === "left"
      ? requested.x - (content.x - actual.x)
      : requested.x + requested.width - (content.x - actual.x) - content.width;
    const y = requested.y - (content.y - actual.y);
    if (x === actual.x && y === actual.y) break;
    // Never feed rounded native dimensions back into a resize: at fractional DPI
    // that can enlarge the transparent reservation on every move.
    target.setBounds({ ...requested, x, y }, false);
    changed = true;
  }
  return changed;
}

export function normalizeEdgeWindowSize(size) {
  return {
    width: Math.max(
      EDGE_WINDOW_MIN_WIDTH,
      Math.round(Number.isFinite(size?.width) ? size.width : EDGE_WINDOW_WIDTH)
    ),
    height: Math.max(
      EDGE_WINDOW_MIN_HEIGHT,
      Math.round(Number.isFinite(size?.height) ? size.height : EDGE_WINDOW_HEIGHT)
    )
  };
}

export function detectEdgeDock(workArea, windowBounds, threshold = EDGE_SNAP_THRESHOLD) {
  const workRight = workArea.x + workArea.width;
  const windowRight = windowBounds.x + windowBounds.width;
  if (windowRight <= workArea.x || windowBounds.x >= workRight) return undefined;
  const leftReached = windowBounds.x <= workArea.x + threshold;
  const rightReached = windowRight >= workRight - threshold;
  if (leftReached && rightReached) {
    return Math.abs(windowBounds.x - workArea.x) <= Math.abs(windowRight - workRight) ? "left" : "right";
  }
  if (leftReached) return "left";
  if (rightReached) return "right";
  return undefined;
}

export function isDockEdgeExposed(display, displays, side, windowBounds) {
  const bounds = display.bounds;
  const edgeX = side === "left" ? bounds.x : bounds.x + bounds.width;
  const windowTop = windowBounds.y;
  const windowBottom = windowBounds.y + windowBounds.height;
  const blocked = displays.some((other) => {
    if (other === display || (display.id != null && other.id != null && String(other.id) === String(display.id))) return false;
    const otherRight = other.bounds.x + other.bounds.width;
    const reachesEdge = side === "left"
      ? other.bounds.x < edgeX && otherRight >= edgeX
      : other.bounds.x <= edgeX && otherRight > edgeX;
    if (!reachesEdge) return false;
    const otherBottom = other.bounds.y + other.bounds.height;
    return Math.max(windowTop, other.bounds.y) < Math.min(windowBottom, otherBottom);
  });
  return !blocked;
}

export function shownEdgeBounds(workArea, size, side, y) {
  const normalizedSize = normalizeEdgeWindowSize(size);
  const width = Math.min(normalizedSize.width, workArea.width);
  const height = Math.min(normalizedSize.height, workArea.height);
  const minY = workArea.y;
  const maxY = workArea.y + workArea.height - Math.min(height, EDGE_HANDLE_HEIGHT);
  return {
    x: side === "left" ? workArea.x : workArea.x + workArea.width - width,
    y: Math.min(maxY, Math.max(minY, Number.isFinite(y) ? Math.round(y) : minY)),
    width,
    height
  };
}

export function restoredEdgeBounds(workArea, size, placement = {}) {
  const restored = shownEdgeBounds(workArea, size, placement.side, placement.y);
  if (placement.docked !== false) return restored;
  return {
    ...restored,
    x: Math.min(
      workArea.x + workArea.width - restored.width,
      Math.max(workArea.x, Number.isFinite(placement.x) ? Math.round(placement.x) : workArea.x)
    )
  };
}

export function edgePlacementUpdate({ displayId, workArea, bounds, side, kind = "move", currentSize }) {
  const size = kind === "resize" ? { width: bounds.width, height: bounds.height } : currentSize;
  const docked = side === "left" || side === "right";
  const shown = restoredEdgeBounds(workArea, size, { docked, side, x: bounds.x, y: bounds.y });
  return {
    bounds: shown,
    settings: {
      edgeWindowDisplayId: String(displayId),
      edgeWindowDocked: docked,
      ...(docked ? { edgeWindowDockSide: side } : { edgeWindowX: shown.x }),
      edgeWindowY: shown.y,
      ...(kind === "resize" ? { edgeWindowWidth: shown.width, edgeWindowHeight: shown.height } : {})
    }
  };
}

export function collapsedEdgeBounds(
  workArea,
  shownBounds,
  side,
  windowWidth = EDGE_HANDLE_WINDOW_WIDTH,
  handleHeight = EDGE_HANDLE_HEIGHT
) {
  const width = Math.min(Math.max(1, Math.round(windowWidth)), workArea.width);
  const height = Math.min(Math.max(1, Math.round(handleHeight)), workArea.height);
  const centeredY = shownBounds.y + (shownBounds.height - height) / 2;
  return {
    x: side === "left" ? workArea.x : workArea.x + workArea.width - width,
    y: Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, Math.round(centeredY))),
    width,
    height
  };
}

export function isPointerNearEdgeMarker(
  workArea,
  markerBounds,
  side,
  point,
  edgeDistance = 24,
  verticalPadding = 12
) {
  if (![point?.x, point?.y, markerBounds?.y, markerBounds?.height].every(Number.isFinite)) return false;
  const edgeX = side === "left" ? workArea.x : workArea.x + workArea.width;
  return Math.abs(point.x - edgeX) <= edgeDistance
    && point.y >= markerBounds.y - verticalPadding
    && point.y <= markerBounds.y + markerBounds.height + verticalPadding;
}

export function isRevealHandleHit(windowHeight, pointerY, handleHeight = EDGE_HANDLE_HEIGHT) {
  if (![windowHeight, pointerY, handleHeight].every(Number.isFinite)) return false;
  const halfHandle = Math.max(1, handleHeight) / 2;
  return Math.abs(pointerY - windowHeight / 2) <= halfHandle;
}

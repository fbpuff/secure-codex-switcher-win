// Isolated Electron fixture: never opens account data or controls Codex.
const { app, BrowserWindow, screen } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

app.whenReady().then(async () => {
  const { positionEdgeHandle, collapsedEdgeBounds } = await import(pathToFileURL(path.join(__dirname, "../src/core/edge-window.js")));
  const area = screen.getPrimaryDisplay().workArea;
  const panel = { x: area.x, y: area.y + 100, width: 360, height: 400 };
  const requested = collapsedEdgeBounds(area, panel, "right");
  const window = new BrowserWindow({ ...requested, show: false, frame: false, transparent: true,
    focusable: false, resizable: false, movable: false, hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  let loads = 0;
  window.webContents.on("did-finish-load", () => { loads++; });
  await window.loadFile(path.join(__dirname, "../src/renderer/edge-handle.html"), { hash: "right" });
  const measurements = [];
  for (const side of ["right", "left", "right"]) {
    const marker = collapsedEdgeBounds(area, panel, side);
    positionEdgeHandle(window, marker, side);
    await window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(side)}`);
    await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const bounds = window.getBounds();
    const content = window.getContentBounds();
    assert.equal(side === "right" ? content.x + content.width : content.x, side === "right" ? area.x + area.width : area.x);
    assert.equal(positionEdgeHandle(window, marker, side), false);
    const capture = await window.webContents.capturePage();
    const size = capture.getSize();
    const pixels = capture.toBitmap();
    let minX = size.width, minY = size.height, maxX = -1, maxY = -1;
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
      const i = (y * size.width + x) * 4;
      if (pixels[i] === 159 && pixels[i + 1] === 120 && pixels[i + 2] === 85 && pixels[i + 3] > 0) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    assert.ok(maxX >= minX, "strip must be painted");
    const painted = { width: maxX - minX + 1, height: maxY - minY + 1 };
    if (measurements.length) {
      assert.deepEqual(painted, measurements[0].painted);
      assert.deepEqual(size, measurements[0].captureSize, "client reservation must not grow when changing sides");
    }
    measurements.push({ side, bounds, content, captureSize: size, painted });
  }
  assert.equal(loads, 1);
  console.log(JSON.stringify({ ok: true, scaleFactor: screen.getPrimaryDisplay().scaleFactor, loads, measurements }));
  window.destroy();
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });

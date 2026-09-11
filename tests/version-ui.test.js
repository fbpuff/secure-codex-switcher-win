import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
const main = read("src/main.js");
const preload = read("src/preload.cjs");
const html = read("src/renderer/index.html");
const css = read("src/renderer/styles.css");
const renderer = read("src/renderer/app.js");

test("runtime version is exposed through a dedicated main-process IPC handler", () => {
  assert.match(main, /"app:getVersion":\s*\(\)\s*=>\s*app\.getVersion\(\)/);
  assert.match(preload, /getAppVersion:\s*\(\)\s*=>\s*invoke\("app:getVersion"\)/);
  assert.doesNotMatch(preload, /app\.getVersion/);
});

test("renderer has one stable, non-hardcoded version slot", () => {
  assert.equal((html.match(/id="app-version"/g) ?? []).length, 1);
  assert.match(html, /<span id="app-version"[^>]*class="app-version"[^>]*><\/span>/);
  assert.doesNotMatch(html, /id="app-version"[^>]*>\s*v?\d+\.\d+\.\d+/i);
  assert.match(css, /\.app-version\s*\{[\s\S]*font-variant-numeric:\s*tabular-nums;[\s\S]*white-space:\s*nowrap;/);
  assert.match(renderer, /const version = await api\.getAppVersion\(\)/);
  assert.match(renderer, /appVersionEl\.textContent/);
  assert.match(renderer, /"brand\.versionUnknown": "版本未知"/);
  assert.match(renderer, /"brand\.versionUnknown": "Version unknown"/);
  assert.doesNotMatch(renderer, /appVersionEl\.textContent\s*=\s*["'`]v?\d+\.\d+\.\d+/);
});

// Hidden, isolated renderer fixture. No preload, account service, or Codex access.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "switcher-status-layout-")));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { partition: "status-layout-fixture", sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    callback({ cancel: !request.url.startsWith("file:") || request.url.endsWith("/app.js") });
  });
  await window.loadFile(path.join(__dirname, "../src/renderer/index.html"));
  const measurements = [];
  for (const width of [1440, 1100, 800]) {
    window.setContentSize(width, 900);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const region = document.querySelector('.account-status-region');
      const workspace = document.querySelector('#accounts-workspace');
      const status = document.querySelector('#status-line');
      const diagnostics = document.querySelector('#activity-diagnostics');
      const warning = document.querySelector('#quota-warning-line');
      const list = document.querySelector('.list-panel');
      const accounts = document.querySelector('#accounts');
      accounts.replaceChildren();
      for (let i = 0; i < 20; i++) {
        const row = document.createElement('div');
        row.className = 'account-row';
        row.textContent = '示例账号 ' + (i + 1) + ' · 仅布局验证';
        accounts.append(row);
      }
      const states = [];
      for (const [text, expanded, warned] of [
        ['准备就绪', false, false],
        ['将在 90 秒后自动切换到示例账号。', false, true],
        ['等待任务完成后切号：' + '研究任务名称与状态说明，'.repeat(40), false, true],
        ['正在等待任务完成', true, true],
        ['Switching in 9 seconds.', false, true]
      ]) {
        status.textContent = text;
        diagnostics.hidden = !expanded;
        diagnostics.open = expanded;
        document.querySelector('#activity-diagnostic-ids').textContent = 'fixture-task\\n'.repeat(20);
        warning.hidden = !warned;
        document.querySelector('#quota-warning-text').textContent = '额度不足，已排队切换到示例账号。';
        await frame();
        const rect = workspace.getBoundingClientRect();
        states.push({ top: rect.top, height: rect.height, statusHeight: region.getBoundingClientRect().height,
          scrollable: region.scrollHeight > region.clientHeight });
      }
      return { width: innerWidth, states };
    })()`);
    for (const state of result.states) {
      assert.equal(state.top, result.states[0].top, "status must not move account workspace");
      assert.equal(state.height, result.states[0].height, "status must not resize account workspace");
    }
    assert.ok(result.states[2].scrollable, "long messages remain accessible by scrolling");
    assert.ok(result.states[3].scrollable, "expanded diagnostics remain accessible by scrolling");
    measurements.push(result);
  }
  console.log(JSON.stringify({ ok: true, measurements }));
  window.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });

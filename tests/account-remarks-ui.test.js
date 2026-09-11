import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../src/renderer/app.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");

test("account remarks use a narrow IPC bridge and render only in the detail header", () => {
  assert.match(main, /"accounts:setRemark": \(_event, accountId, remark\) => accountService\.setAccountRemark\(accountId, remark\)/);
  assert.match(preload, /setAccountRemark: \(accountId, remark\) => invoke\("accounts:setRemark", accountId, remark\)/);
  assert.match(app, /class="detail-remark"/);
  assert.match(app, /id="detail-edit-remark"/);
  assert.match(app, /api\.setAccountRemark\(account\.id, remark\)/);
  assert.match(css, /\.detail-remark/);

  const listRenderer = app.slice(app.indexOf("function renderAccounts()"), app.indexOf("function selectAccount("));
  assert.doesNotMatch(listRenderer, /account\.remark/);
});

test("account remarks use the app dialog, safe input validation, and a bold shared detail type scale", () => {
  assert.match(html, /<dialog id="remark-dialog" class="modal-dialog"(?:\s[^>]*)?>/);
  assert.match(html, /<input id="remark-input" maxlength="80" type="text"/);
  assert.match(app, /const remarkDialog = document\.querySelector\("#remark-dialog"\);/);
  assert.match(app, /remarkDialog\.showModal\(\)/);
  assert.doesNotMatch(app, /const remark = prompt\(t\("detail\.remarkPrompt"\)/);
  assert.match(app, /remarkDialog\.addEventListener\("submit",/);
  assert.match(app, /remarkInput\.setCustomValidity\(t\("modal\.remarkInvalid"\)\)/);
  assert.match(app, /remarkInput\.reportValidity\(\)/);
  assert.match(css, /\.detail-remark\s*\{[\s\S]*font-family:\s*inherit;[\s\S]*font-size:\s*13px;/);
  assert.match(css, /\.detail-remark strong\s*\{[\s\S]*font-family:\s*inherit;[\s\S]*font-size:\s*inherit;[\s\S]*line-height:\s*inherit;[\s\S]*font-weight:\s*700;/);
});

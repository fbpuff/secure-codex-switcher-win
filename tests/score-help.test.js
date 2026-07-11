import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../src/renderer/app.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

test("best-score metric exposes an accessible help popover", () => {
  assert.match(html, /id="help-circle-symbol"/);
  assert.match(html, /id="score-help-button"[^>]*aria-controls="score-help-popover"[^>]*aria-expanded="false"/);
  assert.match(html, /id="score-help-button"[\s\S]*?<use href="#help-circle-symbol"><\/use>[\s\S]*?<span id="score-help-popover"/);
  assert.match(html, /id="score-help-popover"[^>]*role="tooltip"/);
  assert.match(html, /data-i18n-aria-label="metrics\.scoreHelpLabel"/);
});

test("score help provides bilingual formula and dynamic breakdown hooks", () => {
  for (const key of [
    "metrics.scoreHelpTitle",
    "metrics.scoreFormula",
    "metrics.scoreResetRule",
    "metrics.scoreMissingRule",
    "metrics.scoreEligibilityRule",
    "metrics.scoreCurrentAccount",
    "metrics.scoreFiveRemaining",
    "metrics.scoreWeekRemaining",
    "metrics.scoreFiveReset",
    "metrics.scoreWeekReset"
  ]) {
    assert.ok(app.split(`"${key}"`).length >= 3, `${key} should exist in both languages and renderer usage`);
  }
  assert.match(app, /function renderScoreHelp\(best\)/);
  assert.match(app, /scoreBreakdown\(best\)/);
  assert.match(app, /最低余量 × 60% \+ 5h 余量 × 20% \+ 7d 余量 × 20%/);
  assert.match(app, /只有可用度分数完全相同时/);
  assert.match(app, /points/);
  assert.doesNotMatch(app, /metricBest\.textContent\s*=.*remainingScore\(best\).*%/);
  assert.match(app, /formatScore\(remainingScore\(best\)\)/);
  assert.match(app, /formatScore\(breakdown\.total\)/);
  assert.match(html, /class="score-help-reset-breakdown"/);
  assert.match(css, /\.score-help-reset-breakdown\s*>\s*span\s*{[^}]*grid-template-columns:/s);
  assert.match(css, /white-space:\s*nowrap/);
});

test("score help supports pinning and all required dismissal paths", () => {
  assert.match(app, /scoreHelpButton\.addEventListener\("click"/);
  assert.match(app, /document\.addEventListener\("pointerdown"/);
  assert.match(app, /document\.addEventListener\("keydown"/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /aria-expanded/);
});

test("score help is anchored without changing metric dimensions", () => {
  assert.match(css, /\.score-help-popover\s*{[^}]*position:\s*fixed/s);
  assert.match(css, /\.score-help-popover\s*{[^}]*max-width:/s);
  assert.match(css, /\.score-help\.is-pinned\s+\.score-help-popover/);
  assert.match(css, /\.score-help:hover\s+\.score-help-popover/);
  assert.match(css, /\.score-help:focus-within\s+\.score-help-popover/);
});

test("account detail exposes an interactive availability explanation", () => {
  assert.match(app, /class="detail-score-help"/);
  assert.match(app, /class="detail-score-help-button"/);
  assert.match(app, /class="detail-score-help-popover"[^>]*role="tooltip"/);
  assert.match(css, /\.detail-score-help:hover\s+\.detail-score-help-popover/);
  assert.match(css, /\.detail-score-help:focus-within\s+\.detail-score-help-popover/);
  assert.match(app, /最低余量 × 60%/);
  assert.match(app, /即时可用度为 0/);
  assert.match(app, /detail\.expectedRecovery/);
  assert.doesNotMatch(app, /短板优先评分|Bottleneck-aware score/);
});

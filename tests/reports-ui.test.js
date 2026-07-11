import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../src/renderer/app.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../src/preload.cjs", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

test("reports navigation appears between usage and settings", () => {
  const usageIndex = html.indexOf('id="usage-nav"');
  const reportsIndex = html.indexOf('id="reports-nav"');
  const settingsIndex = html.indexOf('id="settings-nav"');
  assert.ok(usageIndex >= 0 && reportsIndex > usageIndex && settingsIndex > reportsIndex);
  assert.match(html, /id="reports-view"/);
  assert.match(html, /data-i18n="nav\.reports"/);
});

test("weekly reports expose week and dimension filters plus transparent summaries", () => {
  for (const id of [
    "reports-week",
    "reports-account-filter",
    "reports-model-filter",
    "reports-effort-filter",
    "reports-confidence-filter",
    "reports-total-tokens",
    "reports-five-capacity",
    "reports-week-capacity",
    "reports-account-table",
    "reports-model-groups",
    "reports-reset-history"
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /function renderReportsView\(/);
  assert.match(app, /function refreshWeeklyReport\(/);
  assert.match(app, /local_observation/);
});

test("renderer IPC supports weekly report loading and private-history reset", () => {
  assert.match(preload, /getDailyUsageReport/);
  assert.match(preload, /getWeeklyUsageReport/);
  assert.match(preload, /clearUsageObservations/);
  assert.match(main, /reports:daily/);
  assert.match(main, /reports:weekly/);
  assert.match(main, /reports:clear/);
  assert.match(app, /confirm\(t\("confirm\.clearUsageObservations"\)\)/);
});

test("reports default to daily mode and retain weekly summaries", () => {
  assert.match(html, /id="reports-mode-daily"[^>]*aria-pressed="true"/);
  assert.match(html, /id="reports-mode-weekly"[^>]*aria-pressed="false"/);
  assert.match(html, /class="reports-mode-segmented"/);
  assert.match(app, /let reportMode = "daily"/);
  assert.match(app, /api\.getDailyUsageReport/);
  assert.match(app, /api\.getWeeklyUsageReport/);
  assert.match(app, /reports\.dailyTitle/);
  assert.match(app, /reports\.weeklyTitle/);
});

test("detail help button is a compact centered circle", () => {
  assert.match(app, /class="help-circle-icon"[^>]*aria-hidden="true"[^>]*>\s*<use href="#help-circle-symbol"><\/use>/s);
  assert.doesNotMatch(app, /detail-score-help-glyph/);
  assert.match(css, /\.detail-score-help-button\s*{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*padding:\s*0/s);
  assert.match(css, /\.help-circle-icon\s*{[^}]*display:\s*block;[^}]*width:\s*14px;[^}]*height:\s*14px/s);
  assert.match(css, /\.detail-score-help-button:focus-visible/);
});

test("account reports use intuitive metrics and secondary capacity evidence", () => {
  assert.doesNotMatch(html, /data-i18n="reports\.tokenRate"/);
  assert.doesNotMatch(html, /data-i18n="reports\.quotaRate"/);
  for (const key of ["reports.composition", "reports.share", "reports.sessions", "reports.averageSession", "reports.attributionConfidence", "reports.coverage", "reports.metricHelp"]) {
    assert.ok(app.split(`"${key}"`).length >= 3, `${key} should be bilingual and used`);
  }
  assert.match(html, /id="reports-capacity-details"/);
  assert.match(html, /class="reports-metric-help"/);
  assert.match(css, /min-height:\s*16px/);
  assert.match(css, /min-width:\s*16px/);
});

test("reports explain metrics and render non-overlapping token bars", () => {
  assert.match(app, /nonCachedInput\s*=\s*Math\.max\(0,\s*usage\.inputTokens\s*-\s*usage\.cachedInputTokens\)/);
  assert.match(app, /class="token-composition-bar"/);
  assert.match(app, /reset\.emailMasked/);
  assert.doesNotMatch(html, /reports\.rateHelp/);
  for (const key of ["reports.accountHelp", "reports.compositionHelp", "reports.modelHelp", "reports.capacityHelp", "reports.resetHelp", "reports.unattributedHelp"]) {
    assert.ok(app.split(`"${key}"`).length >= 3, `${key} should be bilingual and used`);
  }
  assert.ok((html.match(/class="reports-metric-help"/g) ?? []).length >= 5);
});

test("renderer removes Electron IPC wrapper from actionable errors", () => {
  assert.match(app, /Error invoking remote method/);
  assert.match(app, /replace\(/);
});

test("switch result distinguishes a verified restart from a fresh launch", () => {
  assert.match(app, /result\.verifiedCodexClosure/);
  assert.match(app, /status\.launchFresh/);
  assert.match(app, /status\.launchOk/);
});

test("token composition uses one viewport-safe interactive donut popover", () => {
  assert.match(html, /id="token-composition-popover"[^>]*role="dialog"/);
  assert.match(app, /token-composition-trigger/);
  assert.match(app, /positionTokenCompositionPopover/);
  assert.match(app, /conic-gradient/);
  assert.match(app, /compositionPinnedTrigger/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(css, /\.token-composition-popover\s*{[^}]*position:\s*fixed/s);
  assert.match(css, /\.token-composition-trigger\s*{[^}]*width:\s*110px/s);
  assert.doesNotMatch(app, /token-composition-legend/);
});

test("account report uses five centered groups without quota-change evidence or horizontal scrolling", () => {
  assert.equal((html.match(/<th class="report-account-group"/g) ?? []).length, 5);
  assert.match(html, /reports\.usageOverview/);
  assert.doesNotMatch(html, /reports\.quotaObservedChange/);
  assert.doesNotMatch(app, /formatQuotaLines/);
  assert.doesNotMatch(app, /class="report-quota-cell"/);
  assert.match(css, /\.reports-table-wrap\s*{[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.report-account-group\s*{[^}]*text-align:\s*center/s);
  assert.match(css, /\.report-account-row\s*>\s*td\s*{[^}]*text-align:\s*center/s);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*\.report-account-row\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
});

test("report layout keeps expandable model evidence", () => {
  assert.match(app, /model-disclosure-button/);
  assert.match(app, /model-evidence-panel/);
  assert.match(app, /expandedModelDisclosure/);
});

test("usage charts share one date toolbar and identical seven-row geometry", () => {
  assert.equal((html.match(/class="usage-date-picker"/g) ?? []).length, 1);
  assert.match(html, /class="usage-chart-toolbar"/);
  assert.match(css, /\.usage-chart-series\s*{[^}]*grid-template-rows:\s*repeat\(7,\s*var\(--usage-chart-row-height\)\)/s);
  assert.match(css, /\.usage-hit-layout\s*{[^}]*gap:\s*6px/s);
  assert.match(css, /--usage-chart-row-height:\s*46px/);
  assert.match(css, /\.usage-bar-row\s*{[^}]*height:\s*var\(--usage-chart-row-height\)/s);
  assert.match(app, /class="usage-extrema-marker"/);
  assert.match(css, /\.usage-bar-value\s*{[^}]*grid-template-rows:/s);
  assert.doesNotMatch(css, /\.usage-bar-row\s*>\s*strong\s*em\s*{[^}]*position:\s*absolute/s);
});

test("desktop account rows preserve table-cell geometry and model controls stay centered", () => {
  assert.match(css, /\.reports-table\s*{[^}]*table-layout:\s*fixed/s);
  assert.doesNotMatch(css, /\.reports-table td:first-child\s*{[^}]*display:\s*grid/s);
  assert.doesNotMatch(css, /\.report-usage-overview\s*{[^}]*display:\s*grid/s);
  assert.match(css, /\.model-disclosure-button\s*{[^}]*display:\s*grid;[^}]*place-items:\s*center/s);
  assert.match(app, /class="report-model-account"[^>]*data-label=/);
});

test("account refresh captures and restores reading context", () => {
  assert.match(app, /function captureAccountReadingContext\(/);
  assert.match(app, /function restoreAccountReadingContext\(/);
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /listPanel\.scrollTop/);
  assert.match(app, /detailEl\.scrollTop/);
});

test("background account refresh commits once after scrolling settles", () => {
  const refreshBody = app.match(/async function refreshAllUsageInBackground\(\)\s*{([\s\S]*?)\n}\n\nfunction clampRefreshInterval/)?.[1] ?? "";
  assert.equal((refreshBody.match(/await loadAccounts\(/g) ?? []).length, 1);
  assert.match(refreshBody, /deferWhileScrolling:\s*true/);
  assert.match(app, /function markAccountScrollActive\(/);
  assert.match(app, /async function waitForAccountScrollIdle\(/);
  assert.match(app, /listPanel\.addEventListener\("scroll", markAccountScrollActive, \{ passive: true \}\)/);
  assert.match(app, /detailEl\.addEventListener\("scroll", markAccountScrollActive, \{ passive: true \}\)/);
});

test("account data updates do not rebuild usage or report views", () => {
  const loadBody = app.match(/async function loadAccounts\([^)]*\)\s*{([\s\S]*?)\n}\n\nfunction captureAccountReadingContext/)?.[1] ?? "";
  assert.match(loadBody, /renderAccountSurfaces\(\)/);
  assert.doesNotMatch(loadBody, /\brender\(\)/);
  assert.doesNotMatch(loadBody, /renderUsageView|renderReportsView/);
});

test("reports keep cached content visible and expose refresh freshness", () => {
  assert.match(html, /id="reports-refresh-state"/);
  assert.match(app, /const reportCache = new Map\(\)/);
  assert.match(app, /function reportCacheKey\(/);
  assert.match(app, /function reportCacheIsFresh\(/);
  assert.match(app, /refreshWeeklyReport\(\{ background: true \}\)/);
  assert.doesNotMatch(app, /if \(weeklyReportLoading\) \{\s*reportsAccountTable\.innerHTML/s);
});

test("internal brand uses the packaged product icon and model disclosures keep icon geometry", () => {
  assert.doesNotMatch(html, />CS<\/span>/);
  assert.match(html, /<img class="brand-mark" src="\.\.\/\.\.\/build\/icon\.png"/);
  assert.doesNotMatch(css, /\.switch-brand-icon::before/);
  assert.match(css, /\.model-disclosure-button::before/);
  assert.doesNotMatch(app, /model-disclosure-button[^\n]*>⌄<\/button>/);
});

test("narrow layouts use a compact horizontal product rail", () => {
  assert.match(css, /@media \(max-width:\s*980px\)[\s\S]*\.rail\s*{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)/s);
  assert.match(css, /@media \(max-width:\s*980px\)[\s\S]*\.nav-stack\s*{[^}]*grid-template-columns:\s*repeat\(4,/s);
  assert.match(css, /@media \(max-width:\s*980px\)[\s\S]*\.topbar\s*>\s*div:first-child\s*{[^}]*flex:\s*0 0 auto/s);
});

test("quota provenance and report states are bilingual", () => {
  for (const key of [
    "nav.reports",
    "reports.title",
    "reports.localOnly",
    "reports.observedEstimate",
    "reports.unattributed",
    "detail.quotaSource",
    "detail.quotaLastRefresh",
    "detail.quotaSnapshotAge"
  ]) assert.ok(app.split(`"${key}"`).length >= 3, `${key} should be defined twice and used`);
});

test("score help uses viewport-aware fixed placement and narrow single-column layout", () => {
  assert.match(app, /function positionScoreHelp\(/);
  assert.match(app, /Math\.min\(440/);
  assert.match(css, /\.score-help-popover\s*{[^}]*position:\s*fixed/s);
  assert.match(css, /grid-template-columns:\s*1fr/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const moduleUrl = new URL("../src/core/report-presentation.js", import.meta.url);
const moduleExists = fs.existsSync(moduleUrl);
const presentation = moduleExists ? await import(moduleUrl) : {};

test("report presentation module exists", () => {
  assert.equal(moduleExists, true);
  assert.equal(typeof presentation.orderReportAccounts, "function");
});

test("orders report rows by the canonical account list and appends deleted history", () => {
  if (!presentation.orderReportAccounts) return;
  const accounts = [
    account("current", "cu***@mail.com", true),
    account("manual", "ma***@mail.com"),
    account("normal", "no***@mail.com"),
    account("excluded", "ex***@mail.com")
  ];
  const reportAccounts = [
    reportAccount("excluded", 900, ["high", "medium"]),
    reportAccount("current", 10, ["medium"]),
    reportAccount("deleted", 500, ["max"])
  ];
  const originalAccounts = structuredClone(accounts);
  const originalReport = structuredClone(reportAccounts);

  const rows = presentation.orderReportAccounts(accounts, reportAccounts);

  assert.deepEqual(rows.map((item) => item.accountId), ["current", "manual", "normal", "excluded", "deleted"]);
  assert.deepEqual(rows.map((item) => item.hasUsage), [true, false, false, true, true]);
  assert.equal(rows[0].isCurrent, true);
  assert.equal(rows[0].totalTokens, 10);
  assert.deepEqual(rows[3].models[0].reasoning.map((item) => item.reasoningEffort), ["high", "medium"]);
  assert.equal(rows[4].emailMasked, "de***@mail.com");
  assert.deepEqual(accounts, originalAccounts);
  assert.deepEqual(reportAccounts, originalReport);
});

test("creates an honest empty presentation row without fabricated observations", () => {
  if (!presentation.orderReportAccounts) return;

  const [row] = presentation.orderReportAccounts([account("current", "cu***@mail.com", true)], []);

  assert.deepEqual(row, {
    accountId: "current",
    emailMasked: "cu***@mail.com",
    planType: "plus",
    isCurrent: true,
    hasUsage: false,
    totalTokens: 0,
    models: []
  });
  assert.equal("attributionConfidence" in row, false);
  assert.equal("sessionCount" in row, false);
});

test("uses a bounded pass over the canonical account list", () => {
  if (!presentation.orderReportAccounts) return;
  let idReads = 0;
  const accounts = Array.from({ length: 1_000 }, (_, index) => {
    const value = account(`account-${index}`, `a${index}***@mail.com`, index === 0);
    return new Proxy(value, {
      get(target, property, receiver) {
        if (property === "id") idReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
  });
  const reportAccounts = accounts.map((_, index) => reportAccount(`account-${999 - index}`, index + 1));

  const rows = presentation.orderReportAccounts(accounts, reportAccounts);

  assert.equal(rows.length, 1_000);
  assert.ok(idReads <= accounts.length * 2, `expected bounded account ID reads, got ${idReads}`);
});

test("builds filtered account options and model rows without losing canonical order", () => {
  assert.equal(typeof presentation.buildReportPresentation, "function");
  const orderedAccounts = presentation.orderReportAccounts(
    [
      account("current", "cu***@mail.com", true),
      account("empty", "em***@mail.com"),
      account("other", "ot***@mail.com")
    ],
    [
      reportAccount("other", 900, ["high"]),
      reportAccount("current", 10, ["medium", "high"]),
      reportAccount("deleted", 500, ["medium"])
    ]
  );

  const result = presentation.buildReportPresentation(orderedAccounts, {
    model: "gpt-5.6-sol",
    effort: "medium"
  }, "high");

  assert.deepEqual(result.accountOptions.map((item) => item.value), ["current", "empty", "other", "deleted"]);
  assert.deepEqual(result.accounts.map((item) => item.accountId), ["current", "deleted"]);
  assert.deepEqual(result.modelRows.map((item) => [item.account.accountId, item.reasoning.reasoningEffort]), [
    ["current", "medium"],
    ["deleted", "medium"]
  ]);
  assert.equal(result.accounts[0].totalTokens, 10);

  const emptyOnly = presentation.buildReportPresentation(orderedAccounts, { accountId: "empty" }, "high");
  assert.deepEqual(emptyOnly.accounts.map((item) => [item.accountId, item.hasUsage]), [["empty", false]]);
  assert.deepEqual(emptyOnly.modelRows, []);

  const confidenceMismatch = presentation.buildReportPresentation(orderedAccounts, { confidence: "medium" }, "high");
  assert.deepEqual(confidenceMismatch.accounts, []);

  const confidenceMatch = presentation.buildReportPresentation(orderedAccounts, { confidence: "high" }, "high");
  assert.deepEqual(confidenceMatch.accounts.map((item) => [item.accountId, item.hasUsage]), [
    ["current", true],
    ["empty", false],
    ["other", true],
    ["deleted", true]
  ]);
});

function account(id, emailMasked, isCurrent = false) {
  return { id, emailMasked, planType: "plus", isCurrent };
}

function reportAccount(accountId, totalTokens, efforts = ["medium"]) {
  return {
    accountId,
    emailMasked: accountId === "deleted" ? "de***@mail.com" : `${accountId.slice(0, 2)}***@mail.com`,
    planType: "plus",
    totalTokens,
    models: [{ model: "gpt-5.6-sol", reasoning: efforts.map((reasoningEffort) => ({ reasoningEffort, totalTokens })) }]
  };
}

export function orderReportAccounts(accounts = [], reportAccounts = []) {
  const pending = new Map(reportAccounts.map((account) => [account.accountId, account]));
  const ordered = accounts.map((account) => {
    const accountId = account.id;
    const reportAccount = pending.get(accountId);
    pending.delete(accountId);
    return reportAccount
      ? { ...reportAccount, isCurrent: Boolean(account.isCurrent), hasUsage: true }
      : {
          accountId,
          emailMasked: account.emailMasked,
          planType: account.planType,
          isCurrent: Boolean(account.isCurrent),
          hasUsage: false,
          totalTokens: 0,
          models: []
        };
  });
  return [...ordered, ...[...pending.values()].map((account) => ({ ...account, isCurrent: false, hasUsage: true }))];
}

export function buildReportPresentation(orderedAccounts, filters = {}, reportConfidence) {
  const accountOptions = orderedAccounts.map((account) => ({ value: account.accountId, label: account.emailMasked }));
  const accounts = filters.confidence && reportConfidence !== filters.confidence
    ? []
    : orderedAccounts
        .filter((account) => !filters.accountId || account.accountId === filters.accountId)
        .map((account) => {
          const models = account.models
            .filter((model) => !filters.model || model.model === filters.model)
            .map((model) => ({
              ...model,
              reasoning: model.reasoning.filter((item) => !filters.effort || item.reasoningEffort === filters.effort)
            }))
            .filter((model) => model.reasoning.length > 0);
          if (!filters.model && !filters.effort) return { ...account, models };
          const totalTokens = models.flatMap((model) => model.reasoning).reduce((sum, item) => sum + item.totalTokens, 0);
          return { ...account, models, totalTokens, tokenRatePerHour: undefined };
        })
        .filter((account) => account.models.length > 0 || (!filters.model && !filters.effort));
  const modelRows = accounts.flatMap((account) => account.models.flatMap((model) =>
    model.reasoning.map((reasoning) => ({ account, model, reasoning }))
  ));
  return { accountOptions, accounts, modelRows };
}

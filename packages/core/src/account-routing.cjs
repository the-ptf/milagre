const os = require("node:os");
const { createCliStatus, cliWhenLoggedIn } = require("./agents/status.cjs");
const { createModelCache } = require("./agents/models.cjs");
const { PROVIDERS } = require("@milagre/shared/providers");

function createAccountRouting({ accounts, cli: baseCli, clientVersion, statusFactory = createCliStatus, modelsFactory = createModelCache }) {
  const cache = new Map();
  function selection(scope) {
    return Object.fromEntries(PROVIDERS.map((provider) => [provider, accounts.selected(provider, scope)]));
  }
  async function forAccount(provider, accountId) {
    const status = await baseCli(provider);
    try {
      return { ...status, accountId, env: accounts.environment(provider, accountId) };
    } catch {
      return { ...status, accountId, problem: "Assigned account not found. Choose another account in Project Accounts.", env: undefined };
    }
  }
  const cli = (provider, scope) => forAccount(provider, accounts.selected(provider, scope));
  function services(scope, ids = selection(scope)) {
    const key = JSON.stringify(ids);
    if (!cache.has(key)) {
      const pinnedCli = (provider) => forAccount(provider, ids[provider]);
      const options = { cli: pinnedCli, cwd: os.homedir(), clientVersion };
      const status = statusFactory(options);
      const models = modelsFactory({ ...options, cli: cliWhenLoggedIn(pinnedCli, status) });
      cache.set(key, { status, models });
    }
    return cache.get(key);
  }
  function invalidate(provider) {
    for (const entry of cache.values()) {
      entry.status.invalidate?.(provider);
      entry.models.invalidate?.(provider);
    }
  }
  return { cli, forAccount, services, selection, invalidate };
}
module.exports = { createAccountRouting };

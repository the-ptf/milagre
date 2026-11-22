const path = require("node:path");
const { createKiroUsage } = require("../kiro-usage.cjs");
const { createUsageReader, readClaudeUsage, readClaudeProfileUsage, readCodexUsage, readAntigravityUsage } = require("../usage.cjs");
const { createUsageStore, cachedSnapshot } = require("../usage-cache.cjs");
const { createTokenUsage, readTokenUsageScopes } = require("../token-usage.cjs");
const { createTokenUsageScan } = require("../token-usage-scan.cjs");
const { createTokenPricing } = require("../token-usage-pricing.cjs");

function createUsage({ options, dataDir, emit, commands, environmentReady, accounts, baseCli, validateAccountScope }) {
  const usageStore = createUsageStore({ file: path.join(dataDir, "usage-cache.json") });
  const kiroUsage = createKiroUsage({ cli: () => baseCli("kiro") });
  const accountUsage = new Map();
  const readers = options.usageReaders ?? {};
  function usageForAccounts(scope, overrides = {}) {
    const claude = overrides.claude ?? accounts.selected("claude", scope),
      codex = overrides.codex ?? accounts.selected("codex", scope),
      antigravity = overrides.antigravity ?? accounts.selected("antigravity", scope);
    const key = `${claude}-${codex}${antigravity === "default" ? "" : `-${antigravity}`}`;
    if (!accountUsage.has(key)) {
      const store =
        claude === "default" && codex === "default" && antigravity === "default"
          ? usageStore
          : createUsageStore({ file: path.join(dataDir, `usage-${key}.json`) });
      accountUsage.set(key, {
        key,
        accountIds: { claude, codex, antigravity, kiro: "default", pi: "default" },
        store,
        read: createUsageReader({
          ready: () => environmentReady,
          store,
          readClaude: async () => {
            const env = accounts.environment("claude", claude);
            if (readers.claude) return readers.claude({ env });
            return env.CLAUDE_CONFIG_DIR ? readClaudeProfileUsage({ command: (await baseCli("claude")).command, env }) : readClaudeUsage();
          },
          readCodex: () => (readers.codex ?? readCodexUsage)({ env: accounts.environment("codex", codex) }),
          readAntigravity: () => (readers.antigravity ?? readAntigravityUsage)({ env: accounts.environment("antigravity", antigravity) }),
          readKiro: readers.kiro ?? kiroUsage,
        }),
      });
    }
    return accountUsage.get(key);
  }

  async function usageWithAccounts(usage, snapshot) {
    const identities = await accounts.list();
    return {
      ...snapshot,
      accountKey: usage.key,
      providers: snapshot.providers.map((provider) => {
        const id = usage.accountIds[provider.provider];
        const account = identities.providers.find((group) => group.provider === provider.provider)?.accounts.find((entry) => entry.id === id);
        return {
          ...provider,
          account: { id, label: account?.label || "Removed account", ...(account?.email ? { email: account.email } : {}) },
        };
      }),
    };
  }

  commands.handle("usage:read", async (_event, scope) => {
    scope = await validateAccountScope(scope, true);
    if (options.readUsage) return options.readUsage();
    await environmentReady;
    const usage = usageForAccounts(scope);
    const snapshot = await usageWithAccounts(usage, await usage.read());
    emit("usage:changed", { scopeKey: scope });
    return snapshot;
  });
  commands.handle("usage:cached", async (_event, scope) => {
    scope = await validateAccountScope(scope, true);
    const usage = usageForAccounts(scope);
    return usageWithAccounts(usage, cachedSnapshot(usage.store, Date.now()));
  });

  async function allAccountUsage(refresh) {
    const identities = await accounts.list();
    const connected = identities.providers
      .filter((group) => group.installed !== false)
      .flatMap((group) => group.accounts.map((account) => ({ ...account, default: group.selectedId === account.id })));
    const providers = await Promise.all(
      connected.map(async (account) => {
        const usage = usageForAccounts(undefined, { claude: "default", codex: "default", antigravity: "default", [account.provider]: account.id });
        const result = account.state === "ready" ? (refresh ? await usage.read.provider(account.provider) : usage.read.cached(account.provider)) : null;
        const checkedAt = usage.read.checkedAt(account.provider);
        return {
          ...(result ?? {
            provider: account.provider,
            status: "unavailable",
            windows: [],
            updatedAt: new Date().toISOString(),
            message:
              account.message ||
              (account.state === "ready" ? "Refresh to check usage." : account.state === "unknown" ? "Checking account sign-in…" : "Account is not signed in."),
          }),
          ...(checkedAt ? { checkedAt } : {}),
          account: {
            id: account.id,
            label: account.label,
            state: account.state,
            ...(account.default ? { default: true } : {}),
            ...(account.email ? { email: account.email } : {}),
          },
        };
      }),
    );
    return {
      generatedAt: new Date().toISOString(),
      accountKey: `all:${connected
        .map((account) => `${account.provider}:${account.id}:${account.state}`)
        .sort()
        .join(",")}`,
      providers,
    };
  }
  commands.handle("usage:accounts:read", async () => {
    await environmentReady;
    const snapshot = await allAccountUsage(true);
    emit("usage:changed", {});
    return snapshot;
  });
  commands.handle("usage:accounts:cached", () => allAccountUsage(false));
  return { usageStore, idle: () => Promise.all([usageStore.idle(), ...[...accountUsage.values()].map((item) => item.store.idle())]) };
}

function registerTokenUsage({
  options,
  dataDir,
  emit,
  commands,
  accounts,
  projectRegistry,
  chatsHome,
  projectStateReadOnly,
  linkStore,
  readRawState,
  worktreeRoot,
}) {
  async function tokenUsageRoots() {
    const roots = [];
    for (const provider of ["claude", "codex"]) {
      const ids = ["default", ...((await accounts.list()).providers.find((group) => group.provider === provider)?.accounts ?? []).map((item) => item.id)];
      for (const id of new Set(ids)) {
        let home;
        try {
          const env = accounts.environment(provider, id);
          home =
            provider === "claude"
              ? env.CLAUDE_CONFIG_DIR || path.join(require("node:os").homedir(), ".claude")
              : env.CODEX_HOME || path.join(require("node:os").homedir(), ".codex");
        } catch {
          continue;
        }
        if (provider === "claude") roots.push({ provider, dir: path.join(home, "projects") });
        else roots.push({ provider, dir: path.join(home, "sessions") }, { provider, dir: path.join(home, "archived_sessions") });
      }
    }
    return roots;
  }
  const tokenUsage =
    options.tokenUsage ??
    createTokenUsage({
      scan: createTokenUsageScan({ cacheFile: path.join(dataDir, "token-usage-cache.json"), roots: tokenUsageRoots }),
      pricing: createTokenPricing({ file: path.join(dataDir, "model-prices.json"), onChange: () => emit("token-usage:changed", {}) }),
      projects: () =>
        readTokenUsageScopes({
          registry: projectRegistry(),
          chatsHome,
          projectState: projectStateReadOnly,
          linkState: (id) => linkStore.cached(id) ?? readRawState(linkStore.directory(id)),
        }),
      worktreeRoot: worktreeRoot(),
      emit,
    });
  commands.handle("token-usage:read", (_event, request) => tokenUsage.read(request));
}

module.exports = { createUsage, registerTokenUsage };

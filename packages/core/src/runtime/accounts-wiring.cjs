const path = require("node:path");
const { createAccountRouting } = require("../account-routing.cjs");
const { createLimitSwitch } = require("../limit-switch.cjs");
const { createLimitResume } = require("../limit-resume.cjs");
const { createMcp } = require("../mcp/index.cjs");
const { createMcpStore } = require("../mcp/store.cjs");
const { openInBrowser } = require("../antigravity-account.cjs");
const { createAccounts } = require("../accounts.cjs");
const { isLinkScopeKey, scopeKey } = require("@milagre/shared/chat-scopes");
const { CHATS_ACCOUNT_LABEL } = require("@milagre/shared/chats-home");
const { antigravityAcp, sweepTempDirs } = require("../agents/antigravity-acp.cjs");
const { createCliCache } = require("../agents/cli.cjs");
const { createAntigravity } = require("../agents/antigravity-install.cjs");
const { refreshInstallPath } = require("../agents/environment.cjs");
const { createLinear } = require("../linear/index.cjs");
const { createLinearIssues } = require("../linear/issues.cjs");
const { createLinearTools } = require("../linear/tools.cjs");
const { createConnectorsWiring } = require("./connectors-wiring.cjs");
const { chatKey, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { resolveProject } = require("../project-identity.cjs");

function createAccountsWiring({ options, dataDir, emit, commands, version, environmentReady, readProject }) {
  const antigravity = options.antigravity ?? createAntigravity({ dataDir });
  void sweepTempDirs(options.antigravityTempRoot ?? antigravityAcp.tempRoot);
  const baseCli = options.agentCli ?? createCliCache({ ready: () => environmentReady, refresh: () => refreshInstallPath(), antigravity });
  const accounts = createAccounts({
    dataDir,
    env: options.accountsEnv,
    cli: baseCli,
    ready: () => environmentReady,
    changed(provider) {
      routing.invalidate(provider);
      options.agentCliStatus?.invalidate?.(provider);
      options.agentModels?.invalidate?.(provider);
      emit("accounts:changed", {});
    },
  });
  const routing = createAccountRouting({ accounts, cli: baseCli, clientVersion: version });
  const agentCli = routing.cli;
  agentCli.invalidate = (provider) => baseCli.invalidate?.(provider);
  commands.handle("accounts:list", (_event, refresh) => accounts.list(refresh === true));
  let accountMutation = Promise.resolve();
  const queueAccountMutation = (run) => {
    const pending = accountMutation.then(run);
    accountMutation = pending.catch(() => {});
    return pending;
  };
  for (const method of ["add", "select", "login", "cancel", "remove"])
    commands.handle(`accounts:${method}`, (_event, provider, value) => queueAccountMutation(() => accounts[method](provider, value)));
  commands.handle("accounts:code", (_event, provider, id, entered) => queueAccountMutation(() => accounts.code(provider, id, entered)));
  const mcpStore = createMcpStore(path.join(dataDir, "mcp.json"));
  const mcp = createMcp({
    accounts,
    routing,
    cwd: require("node:os").homedir(),
    clientVersion: version,
    store: mcpStore,
    openUrl: (url) => openInBrowser(url),
    emit,
    ...options.mcp,
  });
  const mcpPrevious = (previous) =>
    previous === undefined || previous === null
      ? undefined
      : {
          name: typeof previous?.name === "string" ? previous.name : "",
          target: typeof previous?.target === "string" ? previous.target : "",
        };
  commands.handle("mcp:accounts", () => mcp.accounts());
  commands.handle("mcp:check", (_event, provider, accountId) => mcp.check(String(provider), String(accountId)));
  commands.handle("mcp:definition", (_event, name, target) => mcp.definition(String(name), String(target)));
  commands.handle("mcp:save", (_event, def, target, previous) => mcp.save(def, String(target), mcpPrevious(previous)));
  commands.handle("mcp:saveUrl", (_event, def, target, previous) => mcp.saveUrl(def, String(target), mcpPrevious(previous)));
  commands.handle("mcp:remove", (_event, name, target) => mcp.remove(String(name), String(target)));
  commands.handle("mcp:toggle", (_event, provider, accountId, name, on) => mcp.toggle(String(provider), String(accountId), String(name), on === true));
  commands.handle("mcp:signIn", (_event, name, targets) => mcp.signIn(String(name), Array.isArray(targets) ? targets : []));
  commands.handle("mcp:cancelSignIn", (_event, name) => mcp.cancelSignIn(String(name)));

  let connectorsWiring = null;
  const linear = createLinear({
    dataDir,
    openWindow: (url) => emit("linear:sign-in-window", { url }),
    ...options.linear,
    changed: () => {
      emit("linear:status-changed", linear.status());
      connectorsWiring?.linearChanged();
    },
  });
  commands.handle("linear:status", () => linear.status());
  commands.handle("linear:connect", (_event, value) => linear.connect({ window: value?.window === true }));
  commands.handle("linear:cancel", () => linear.cancel());
  commands.handle("linear:disconnect", (_event, value) => linear.disconnect(value?.workspace));
  commands.handle("linear:enabled:read", () => ({ enabled: linear.enabled(), moveToStarted: linear.moveToStarted() }));
  commands.handle("linear:move-to-started:save", (_event, value) => ({ moveToStarted: linear.setMoveToStarted(value === true) }));
  commands.handle("linear:enabled:save", (_event, value) => {
    const enabled = linear.setEnabled(value === true);
    emit("linear:enabled-changed", { enabled });
    return { enabled };
  });
  const linearIssues = createLinearIssues({ linear });
  const linearTools = createLinearTools({ linear, issues: linearIssues });
  commands.handle("routines:linear-options", (_event, value) => linearIssues.routineOptions({ workspace: value?.workspace, team: value?.team }));
  commands.handle("linear:issues", (_event, value) => linearIssues.list(value?.query, { fresh: value?.fresh === true, workspace: value?.workspace }));
  commands.handle("linear:worktree-issues", async (_event, projectPath) => {
    try {
      await environmentReady;
      const project = await readProject(projectPath);
      return await linearIssues.worktreeIssues(Object.values(project.state.worktrees));
    } catch {
      return {};
    }
  });
  connectorsWiring = createConnectorsWiring({ options, dataDir, emit, commands, version, mcp, mcpStore, linear, linearTools });
  const integrations = {
    linearTools,
    tools: connectorsWiring.tools,
    connectorToolGroup: connectorsWiring.toolGroup,
    dispose: () => Promise.all([linear.dispose(), connectorsWiring.dispose()]),
  };
  return { antigravity, baseCli, accounts, routing, agentCli, mcp, linear, linearIssues, integrations, queueAccountMutation };
}

function registerAccountScopes({
  options,
  dataDir,
  commands,
  environmentReady,
  accounts,
  queueAccountMutation,
  chats,
  scopeStates,
  projectRegistry,
  projectName,
  chatsHome,
  chatsHomeEntries,
  projectStateReadOnly,
  ownProject,
}) {
  async function accountScopes() {
    const projects = await projectRegistry().list();
    const registry = await projectRegistry().snapshot();
    return [
      ...projects.map((p) => ({
        key: p.path,
        name: p.name || projectName(p.path),
        kind: "project",
        projects: [{ id: p.id, path: p.path, name: p.name || projectName(p.path) }],
      })),
      ...(registry.projectGroups ?? []).map((link) => ({
        key: scopeKey({ kind: "link", linkId: link.id }),
        name: link.name,
        kind: "link",
        projects: link.projectIds
          .map((id) => projects.find((p) => p.id === id))
          .filter(Boolean)
          .map(({ id, path, name }) => ({ id, path, name })),
      })),
      ...((await chatsHome.exists())
        ? [
            {
              key: chatsHome.path,
              name: CHATS_ACCOUNT_LABEL,
              kind: "project",
              chatsHome: true,
              projects: [{ id: chatsHome.path, path: chatsHome.path, name: CHATS_ACCOUNT_LABEL }],
            },
          ]
        : []),
    ];
  }
  async function validateAccountScope(key, optional = false) {
    if (key === undefined || key === null) {
      if (optional) return undefined;
      throw new Error("Choose a Project or Link.");
    }
    if (typeof key !== "string" || !key) throw new Error("Choose a valid Project or Link.");
    const scopes = await accountScopes();
    if (scopes.some((scope) => scope.key === key)) return key;
    throw new Error("Project or Link is no longer available. Refresh and choose another.");
  }
  async function accountScopeForFolder(cwd) {
    if (!cwd) throw new Error("Choose a Chat folder.");
    for (const key of scopeStates.projects().filter(isLinkScopeKey)) {
      const state = await scopeStates.get(key);
      if (state.deletedAt) continue;
      if (Object.values(state.sessions).some((s) => s.workspacePath === cwd || s.worktrees?.some((m) => m.worktreePath === cwd))) return key;
    }
    return (await resolveProject(cwd)).path;
  }
  commands.handle("accounts:scopes", () => accountScopes());
  function assignAccount(key, provider, id, { canAssign, preserveChat } = {}) {
    const invalidating = scopeStates.has(key)
      ? scopeStates.get(key).then((state) =>
          Promise.all(
            Object.values(state.sessions)
              .filter(
                (session) =>
                  chatKey(key, session.id) !== preserveChat && (session.limitTurn?.provider === provider || session.limitResume?.provider === provider),
              )
              .map((session) => chats.cancelLimitResume(key, session.id)),
          ),
        )
      : Promise.resolve();
    for (const chatId of chats.limitResumeGenerations.keys())
      if (chatId !== preserveChat && projectOfKey(chatId) === key) chats.invalidateLimitResume(key, sessionIdFromKey(chatId));
    return queueAccountMutation(async () => {
      await invalidating;
      const validated = await validateAccountScope(key);
      if (canAssign && !canAssign()) return null;
      return accounts.assign(validated, provider, id);
    });
  }
  const limitSwitch = createLimitSwitch({
    file: path.join(dataDir, "limit-switch.json"),
    assign: assignAccount,
    scope: async (key) => accounts.scope(await validateAccountScope(key)),
    chats,
  });
  commands.handle("accounts:scope", async (_event, key, refresh) =>
    limitSwitch.decorate(await accounts.scope(await validateAccountScope(key), refresh === true)),
  );
  commands.handle("accounts:assign", async (_event, key, provider, id) => limitSwitch.decorate(await assignAccount(key, provider, id)));
  commands.handle("chat:limit-switch", (_event, projectPath, sessionId, provider, accountId) => {
    if (!scopeStates.has(projectPath)) throw new Error("Open the project before switching its account.");
    if (typeof accountId !== "string" || !accountId) throw new Error("Choose an account.");
    return limitSwitch.switchTo(projectPath, Number(sessionId), provider, accountId);
  });
  commands.handle("limits:auto-switch:read", () => ({ autoSwitch: limitSwitch.autoSwitch() }));
  commands.handle("limits:auto-switch:save", (_event, value) => ({ autoSwitch: limitSwitch.setAutoSwitch(value === true) }));
  const limitResume = createLimitResume({
    ...options.limitResume,
    chats,
    settings: limitSwitch,
    scopes: async () => {
      await environmentReady;
      const registry = await projectRegistry().snapshot();
      return [
        ...new Set([
          ...registry.projects.map((project) => project.path),
          ...(await chatsHomeEntries()).map((project) => project.path),
          ...(registry.projectGroups ?? []).map((link) => scopeKey({ kind: "link", linkId: link.id })),
          ...scopeStates.projects(),
        ]),
      ];
    },
    readState: (key) => (isLinkScopeKey(key) ? scopeStates.get(key) : projectStateReadOnly(key)),
    prepareScope: async (key) => {
      await environmentReady;
      if (!isLinkScopeKey(key)) await ownProject(key);
      await scopeStates.get(key);
    },
    accountId: async (key, provider) => {
      await environmentReady;
      return accounts.selected(provider, key);
    },
  });
  commands.handle("limits:resume-at-reset:read", () => ({ resumeAtReset: limitSwitch.resumeAtReset() }));
  commands.handle("limits:resume-at-reset:save", (_event, value) => ({ resumeAtReset: limitSwitch.setResumeAtReset(value === true) }));
  function validateLimitChat(key, sessionId) {
    if (!scopeStates.has(key) || !Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error("Open this Chat before changing its continuation.");
  }
  commands.handle("chat:limit-resume", (_event, key, sessionId, sourceMessageId) => {
    validateLimitChat(key, sessionId);
    if (!Number.isSafeInteger(sourceMessageId) || sourceMessageId < 1) throw new Error("Choose a usage-limited reply.");
    return limitResume.schedule(key, sessionId, sourceMessageId);
  });
  commands.handle("chat:limit-resume:cancel", (_event, key, sessionId, sendId) => {
    validateLimitChat(key, sessionId);
    if (typeof sendId !== "string" || !sendId) throw new Error("Choose a pending continuation.");
    return chats.cancelLimitResume(key, sessionId, sendId);
  });
  return { validateAccountScope, accountScopeForFolder, assignAccount, limitSwitch, limitResume };
}

module.exports = { createAccountsWiring, registerAccountScopes };

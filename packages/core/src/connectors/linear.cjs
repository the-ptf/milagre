const { createLinearTools, linearToolDefinitions } = require("../linear/tools.cjs");

const LINEAR_ID = "linear";
const accessKey = (provider, accountId) => `${provider}:${accountId}`;

const offFor = (access, id) => (Object.hasOwn(access.workspaceOff, id) ? access.workspaceOff[id] : access.off);
const withAccess = (off, key, on) => (on ? off.filter((value) => value !== key) : [...new Set([...off, key])]);

function createLinearConnector({ linear, linearIssues, linearTools, store }) {
  const definitions = (tools = linearTools) => linearToolDefinitions(tools);
  const allTools = () => (linear.enabled() ? definitions() : []);
  function allowedWorkspaces(context) {
    const access = store.readAccess(LINEAR_ID);
    const key = accessKey(context.provider, context.accountId);
    return linear
      .workspaces()
      .filter(({ id }) => !offFor(access, id).includes(key))
      .map(({ id }) => id);
  }
  function summary() {
    const status = linear.status();
    if (!status.connected) return null;
    const access = store.readAccess(LINEAR_ID);
    const workspaceAccess = (status.workspaces ?? []).map(({ id, organization }) => ({ id, name: organization.name, off: offFor(access, id) }));
    const off = workspaceAccess.length ? workspaceAccess[0].off.filter((key) => workspaceAccess.every((workspace) => workspace.off.includes(key))) : access.off;
    return {
      id: LINEAR_ID,
      name: "Linear",
      kind: "linear",
      url: "https://linear.app",
      workspaces: workspaceAccess.map(({ name }) => name),
      workspaceAccess,
      clientId: null,
      hasClientSecret: false,
      headers: [],
      env: [],
      off,
      state: "connected",
      running: false,
      tools: definitions().length,
    };
  }
  return {
    id: LINEAR_ID,
    summary,
    tools(context) {
      if (!context?.provider || !context.accountId || !linear.enabled()) return [];
      const workspaceIds = () => allowedWorkspaces(context);
      return workspaceIds().length ? definitions(createLinearTools({ linear, issues: linearIssues, workspaceIds })) : [];
    },
    /** The `linear_*` tools whatever Available to says, for an outside MCP client whose grant names Linear. */
    allTools,
    setAccess(provider, accountId, on, workspace) {
      const access = store.readAccess(LINEAR_ID);
      const key = accessKey(provider, accountId);
      if (workspace === undefined) {
        access.off = withAccess(access.off, key, on);
        for (const [id, off] of Object.entries(access.workspaceOff)) access.workspaceOff[id] = withAccess(off, key, on);
      } else {
        if (!linear.workspaces().some(({ id }) => id === workspace)) throw new Error("This Linear workspace is no longer connected.");
        access.workspaceOff = { ...access.workspaceOff, [workspace]: withAccess(offFor(access, workspace), key, on) };
      }
      store.saveAccess(LINEAR_ID, access);
      return summary();
    },
    describe: () =>
      definitions().map(({ name, description, readOnly }) => ({ name, description, inputSchema: {}, annotations: { readOnlyHint: readOnly === true } })),
    signIn: async () => {
      await linear.connect();
      return summary();
    },
    signOut: async () => {
      await linear.disconnect();
      return summary();
    },
  };
}

module.exports = { createLinearConnector, LINEAR_ID };

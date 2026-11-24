const { linearToolDefinitions } = require("../linear/tools.cjs");

const LINEAR_ID = "linear";
const accessKey = (provider, accountId) => `${provider}:${accountId}`;

/**
 * Milagre's own Linear sign-in as a Connector: it keeps its GraphQL sign-in (issue starts, Worktree links, Routines) and gains
 * the per-Account Available to its `linear_*` tools follow. It shows while a workspace is signed in.
 */
function createLinearConnector({ linear, linearTools, store }) {
  const off = () => store.readAccess(LINEAR_ID);
  const definitions = () => linearToolDefinitions(linearTools);
  function summary() {
    const status = linear.status();
    if (!status.connected) return null;
    const workspaces = (status.workspaces ?? []).map((workspace) => workspace.organization?.name).filter(Boolean);
    return {
      id: LINEAR_ID,
      name: "Linear",
      kind: "linear",
      url: "https://linear.app",
      workspaces,
      clientId: null,
      hasClientSecret: false,
      headers: [],
      env: [],
      off: off(),
      state: "connected",
      running: false,
      tools: definitions().length,
    };
  }
  return {
    id: LINEAR_ID,
    summary,
    allows: (context) => !context?.provider || !off().includes(accessKey(context.provider, context.accountId)),
    tools: (context) => (linear.enabled() && !off().includes(accessKey(context?.provider, context?.accountId)) ? definitions() : []),
    setAccess(provider, accountId, on) {
      const next = new Set(off());
      if (on) next.delete(accessKey(provider, accountId));
      else next.add(accessKey(provider, accountId));
      store.saveAccess(LINEAR_ID, [...next]);
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

const { createEmailTools, emailConnectDefinition, emailToolDefinitions } = require("../email/tools.cjs");

const EMAIL_ID = "email";
const accessKey = (provider, accountId) => `${provider}:${accountId}`;
const offFor = (access, id) => (Object.hasOwn(access.workspaceOff, id) ? access.workspaceOff[id] : access.off);
const withAccess = (off, key, on) => (on ? off.filter((value) => value !== key) : [...new Set([...off, key])]);

/** Milagre's own Email connector: each mailbox is an access group, like a Linear workspace, so Available to is chosen per mailbox. */
function createEmailConnector({ email, store, secretsDir }) {
  const connect = emailConnectDefinition({ email, secretsDir });
  const definitions = (tools) => [...emailToolDefinitions(tools), connect];
  const addresses = () => email.mailboxes().map(({ address }) => address);
  function allowed(context) {
    const access = store.readAccess(EMAIL_ID);
    const key = accessKey(context.provider, context.accountId);
    return addresses().filter((address) => !offFor(access, address).includes(key));
  }
  function summary() {
    const mailboxes = email.mailboxes();
    if (!mailboxes.length) return null;
    const access = store.readAccess(EMAIL_ID);
    const workspaceAccess = mailboxes.map(({ address }) => ({ id: address, name: address, off: offFor(access, address) }));
    const off = workspaceAccess[0].off.filter((key) => workspaceAccess.every((group) => group.off.includes(key)));
    return {
      id: EMAIL_ID,
      name: "Email",
      kind: "email",
      url: "",
      workspaces: mailboxes.map(({ address }) => address),
      workspaceAccess,
      mailboxes: mailboxes.map(({ address, host, port }) => ({ address, host, port })),
      clientId: null,
      hasClientSecret: false,
      headers: [],
      env: [],
      off,
      state: "connected",
      running: false,
      tools: 2,
    };
  }
  return {
    id: EMAIL_ID,
    summary,
    /** `email_connect` for every Chat, so an agent can set a mailbox up; `email_recent` once the Account may read one. */
    tools(context) {
      if (!context?.provider || !context.accountId) return [];
      if (!allowed(context).length) return [connect];
      return definitions(createEmailTools({ email, mailboxes: () => allowed(context) }));
    },
    /** The email tools over every mailbox, for an outside MCP client whose grant names Email. */
    allTools: () => (addresses().length ? definitions(createEmailTools({ email, mailboxes: addresses })) : [connect]),
    setAccess(provider, accountId, on, mailbox) {
      const access = store.readAccess(EMAIL_ID);
      const key = accessKey(provider, accountId);
      if (mailbox === undefined) {
        access.off = withAccess(access.off, key, on);
        for (const [id, off] of Object.entries(access.workspaceOff)) access.workspaceOff[id] = withAccess(off, key, on);
      } else {
        if (!addresses().includes(mailbox)) throw new Error("This mailbox is no longer connected.");
        access.workspaceOff = { ...access.workspaceOff, [mailbox]: withAccess(offFor(access, mailbox), key, on) };
      }
      store.saveAccess(EMAIL_ID, access);
      return summary();
    },
    describe: () =>
      definitions({ recent: async () => "" }).map(({ name, description, readOnly }) => ({
        name,
        description,
        inputSchema: {},
        annotations: { readOnlyHint: readOnly === true },
      })),
    remove(mailbox) {
      email.disconnect(mailbox);
      return summary();
    },
  };
}

module.exports = { createEmailConnector, EMAIL_ID };

const { createHash } = require("node:crypto");

const OWNER_VARIABLE = "MILAGRE_BROWSER_OWNER";
const OWNER_TOKEN = /^[a-f0-9]{16}$/;

function browserOwnerToken(chatId) {
  return createHash("sha256").update(String(chatId)).digest("hex").slice(0, 16);
}

/**
 * An agent's environment with its Chat's browser owner token, which a browser started by a detached daemon (agent-browser,
 * an MCP server that forks) inherits, plus an agent-browser session of the Chat's own so two Chats never share one browser.
 */
function withBrowserOwner(chatId, env = process.env) {
  const token = browserOwnerToken(chatId);
  return { ...env, [OWNER_VARIABLE]: token, AGENT_BROWSER_SESSION: env.AGENT_BROWSER_SESSION || `milagre-${token}` };
}

/** The owner token in a process's environment: NUL-separated (Linux /proc/<pid>/environ) or `ps -E` output, last value wins. */
function ownerTokenIn(text) {
  let token = null;
  for (const match of String(text).matchAll(/(?:^|[\s\0])MILAGRE_BROWSER_OWNER=([a-f0-9]{16})(?=[\s\0]|$)/g)) token = match[1];
  return token && OWNER_TOKEN.test(token) ? token : null;
}

module.exports = { OWNER_VARIABLE, browserOwnerToken, withBrowserOwner, ownerTokenIn };

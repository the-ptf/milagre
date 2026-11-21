const { ClaudeSession } = require("../agents/claude-provider.cjs");
const { CodexSession } = require("../agents/codex-provider.cjs");
const { PiSession } = require("../agents/pi-session.cjs");
const { AcpSession } = require("../agents/acp-session.cjs");
const { antigravityAcp } = require("../agents/antigravity-acp.cjs");
const { kiroAcp } = require("../agents/kiro-acp.cjs");

/** The session class for a provider's agent, given SessionManager's options plus the Chat's MCP extras. */
function createProviderSession(provider, options, { version, claudeConfigDir }) {
  if (provider === "codex") return new CodexSession({ ...options, clientVersion: version });
  if (provider === "antigravity") return new AcpSession({ ...options, clientVersion: version, config: antigravityAcp });
  if (provider === "kiro") return new AcpSession({ ...options, clientVersion: version, config: kiroAcp });
  if (provider === "ollama") return new PiSession(options);
  return new ClaudeSession({ ...options, defaultConfigDir: claudeConfigDir() });
}

module.exports = { createProviderSession };

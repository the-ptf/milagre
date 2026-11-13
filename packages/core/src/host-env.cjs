// Variables that describe Milagre's own host process, not a program it starts for the user. The host runs on the app's
// Electron binary with ELECTRON_RUN_AS_NODE=1: passed on, it makes every Electron app started from an agent's shell or a
// Terminal (VS Code's `code`, Slack, a dev copy of Milagre) run as plain Node. ELECTRON_NO_ATTACH_CONSOLE is Electron's
// too, MILAGRE_BUNDLED_BIN_DIR points the host at its own bundled tools, and PWD, OLDPWD, SHLVL and _ belong to the
// shell that started the host.
const HOST_ONLY = new Set(["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "MILAGRE_BUNDLED_BIN_DIR", "PWD", "OLDPWD", "SHLVL", "_"]);

/** A copy of `env` without the host's own variables, for a process Milagre starts on the user's behalf. */
function withoutHostVariables(env = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(env)) if (!HOST_ONLY.has(key) && typeof value === "string") result[key] = value;
  return result;
}

module.exports = { HOST_ONLY, withoutHostVariables };

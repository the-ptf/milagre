// Electron binary with ELECTRON_RUN_AS_NODE=1: passed on, it makes every Electron app started from an agent's shell or a
// Terminal (VS Code's `code`, Slack, a dev copy of Milagre) run as plain Node. ELECTRON_NO_ATTACH_CONSOLE is Electron's
const HOST_ONLY = new Set(["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "MILAGRE_BUNDLED_BIN_DIR", "PWD", "OLDPWD", "SHLVL", "_"]);

function withoutHostVariables(env = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(env)) if (!HOST_ONLY.has(key) && typeof value === "string") result[key] = value;
  return result;
}

module.exports = { HOST_ONLY, withoutHostVariables };

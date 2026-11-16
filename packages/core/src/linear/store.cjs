const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { preparePrivateDirectory } = require("../private-files.cjs");

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const validToken = (token) =>
  Boolean(token && typeof token.accessToken === "string" && typeof token.refreshToken === "string" && Number.isFinite(token.expiresAt));
const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const isWorkspaceId = (id) => typeof id === "string" && WORKSPACE_ID.test(id);

function createLinearStore({ dataDir }) {
  const root = path.join(dataDir, "linear");
  const workspacesDir = path.join(root, "workspaces");
  const legacyFile = path.join(root, "token.json");
  const settingsFile = path.join(root, "settings.json");
  function write(file, value) {
    preparePrivateDirectory(root);
    if (path.dirname(file) !== root) preparePrivateDirectory(path.dirname(file));
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  const fileOf = (id) => path.join(workspacesDir, `${id.toLowerCase()}.json`);
  function migrate() {
    const legacy = read(legacyFile);
    if (!legacy) return;
    const id = legacy.organization?.urlKey;
    if (validToken(legacy) && isWorkspaceId(id) && !fs.existsSync(fileOf(id))) write(fileOf(id), { connectedAt: 0, ...legacy });
    fs.rmSync(legacyFile, { force: true });
  }
  function readToken(id) {
    if (!isWorkspaceId(id)) return null;
    const token = read(fileOf(id));
    return validToken(token) ? token : null;
  }
  return {
    listWorkspaces() {
      if (fs.existsSync(legacyFile)) migrate();
      let names = [];
      try {
        names = fs.readdirSync(workspacesDir).filter((name) => name.endsWith(".json"));
      } catch {
        return [];
      }
      return names
        .map((name) => {
          const id = name.slice(0, -".json".length);
          const token = readToken(id);
          return token ? { id, ...token } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a.connectedAt ?? 0) - (b.connectedAt ?? 0) || a.id.localeCompare(b.id));
    },
    workspace(id) {
      if (!isWorkspaceId(id)) throw new Error(`${JSON.stringify(String(id))} isn't a Linear workspace.`);
      return {
        readToken: () => readToken(id),
        saveToken: (token) => write(fileOf(id), token),
        clearToken: () => fs.rmSync(fileOf(id), { force: true }),
      };
    },
    readEnabled: () => read(settingsFile)?.enabled === true,
    saveEnabled(value) {
      write(settingsFile, { ...read(settingsFile), enabled: value === true });
      return value === true;
    },
    readMoveToStarted: () => read(settingsFile)?.moveToStarted !== false,
    saveMoveToStarted(value) {
      write(settingsFile, { ...read(settingsFile), moveToStarted: value === true });
      return value === true;
    },
  };
}

module.exports = { createLinearStore, isWorkspaceId };

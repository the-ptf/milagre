const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { preparePrivateDirectory } = require("../private-files.cjs");

const CONNECTOR_ID = /^[a-z][a-z0-9_]{0,15}$/;
const isConnectorId = (id) => typeof id === "string" && CONNECTOR_ID.test(id);

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readForWrite(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    fs.copyFileSync(file, `${file}.bad`);
    throw new Error(`${path.basename(file)} is damaged; a copy is at ${path.basename(file)}.bad. Fix or delete it.`);
  }
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const accessKeys = (value) => (Array.isArray(value) ? value.filter((key) => typeof key === "string") : []);
const validConnector = (value) => isObject(value) && isConnectorId(value.id) && typeof value.name === "string" && typeof value.url === "string";

function createConnectorStore({ dataDir }) {
  const root = path.join(dataDir, "connectors");
  const secretsDir = path.join(root, "secrets");
  const listFile = path.join(root, "connectors.json");
  const builtinFile = path.join(root, "builtin.json");
  function write(file, value) {
    preparePrivateDirectory(root);
    if (path.dirname(file) !== root) preparePrivateDirectory(path.dirname(file));
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  const toolsFile = (id) => path.join(root, "tools", `${id}.json`);
  const secretFile = (id) => {
    if (!isConnectorId(id)) throw new Error(`${JSON.stringify(String(id))} isn't a connector.`);
    return path.join(secretsDir, `${id}.json`);
  };
  function list() {
    const value = read(listFile);
    return Array.isArray(value?.connectors) ? value.connectors.filter(validConnector) : [];
  }
  function listForWrite() {
    const value = readForWrite(listFile);
    if (value === null) return [];
    if (!Array.isArray(value?.connectors)) throw new Error("connectors.json isn't a connector list. Fix or delete it.");
    return value.connectors.filter(validConnector);
  }
  function save(connector) {
    const current = listForWrite();
    const index = current.findIndex((item) => item.id === connector.id);
    write(listFile, { connectors: index < 0 ? [...current, connector] : current.with(index, connector) });
  }
  return {
    list,
    get: (id) => list().find((item) => item.id === id) ?? null,
    save,
    remove(id) {
      write(listFile, { connectors: listForWrite().filter((item) => item.id !== id) });
      fs.rmSync(secretFile(id), { force: true });
      fs.rmSync(toolsFile(id), { force: true });
    },
    readAccess: (id) => {
      const value = read(builtinFile)?.[id];
      return {
        off: accessKeys(value?.off),
        workspaceOff: Object.fromEntries(
          Object.entries(value?.workspaceOff ?? {})
            .filter(([, keys]) => Array.isArray(keys))
            .map(([workspace, keys]) => [workspace, accessKeys(keys)]),
        ),
      };
    },
    saveAccess(id, access) {
      write(builtinFile, { ...readForWrite(builtinFile), [id]: access });
    },
    /** Everywhere servers moved here automatically that the user hasn't dismissed the note about. */
    readMoved: () => (Array.isArray(read(path.join(root, "moved.json"))) ? read(path.join(root, "moved.json")) : []),
    saveMoved: (names) => write(path.join(root, "moved.json"), names),
    /** The tool list the server last answered, so a command connector's tools are offered without starting it. */
    readTools: (id) => (isConnectorId(id) && Array.isArray(read(toolsFile(id))) ? read(toolsFile(id)) : null),
    saveTools: (id, tools) => isConnectorId(id) && write(toolsFile(id), tools),
    secrets(id) {
      const file = secretFile(id);
      return {
        read: () => (isObject(read(file)) ? read(file) : {}),
        update(patch) {
          const current = readForWrite(file);
          const next = { ...(isObject(current) ? current : {}), ...patch };
          for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
          write(file, next);
        },
        clear: () => fs.rmSync(file, { force: true }),
      };
    },
  };
}

module.exports = { createConnectorStore, isConnectorId };

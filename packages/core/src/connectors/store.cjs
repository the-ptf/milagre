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

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validConnector = (value) => isObject(value) && isConnectorId(value.id) && typeof value.name === "string" && typeof value.url === "string";

function createConnectorStore({ dataDir }) {
  const root = path.join(dataDir, "connectors");
  const secretsDir = path.join(root, "secrets");
  const listFile = path.join(root, "connectors.json");
  function write(file, value) {
    preparePrivateDirectory(root);
    if (path.dirname(file) !== root) preparePrivateDirectory(path.dirname(file));
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  const secretFile = (id) => {
    if (!isConnectorId(id)) throw new Error(`${JSON.stringify(String(id))} isn't a connector.`);
    return path.join(secretsDir, `${id}.json`);
  };
  function list() {
    const value = read(listFile);
    return Array.isArray(value?.connectors) ? value.connectors.filter(validConnector) : [];
  }
  function save(connector) {
    const current = list();
    const index = current.findIndex((item) => item.id === connector.id);
    write(listFile, { connectors: index < 0 ? [...current, connector] : current.with(index, connector) });
  }
  return {
    list,
    get: (id) => list().find((item) => item.id === id) ?? null,
    save,
    remove(id) {
      write(listFile, { connectors: list().filter((item) => item.id !== id) });
      fs.rmSync(secretFile(id), { force: true });
    },
    secrets(id) {
      const file = secretFile(id);
      return {
        read: () => (isObject(read(file)) ? read(file) : {}),
        update(patch) {
          const next = { ...(isObject(read(file)) ? read(file) : {}), ...patch };
          for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
          write(file, next);
        },
        clear: () => fs.rmSync(file, { force: true }),
      };
    },
  };
}

module.exports = { createConnectorStore, isConnectorId };

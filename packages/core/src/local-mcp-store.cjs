const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { z } = require("zod");
const { preparePrivateDirectory, assertPrivate, windowsAcl } = require("./private-files.cjs");

const paths = z.union([z.literal("*"), z.array(z.string().max(8192).refine(path.isAbsolute, "Absolute Project paths are required")).max(100)]);
const capabilities = (values) => z.array(z.enum(values)).min(1);
const grantsSchema = z
  .strictObject({
    projects: z.strictObject({ projectPaths: paths, capabilities: capabilities(["read", "create"]) }).optional(),
    worktrees: z.strictObject({ projectPaths: paths, capabilities: capabilities(["read", "create"]) }).optional(),
    chats: z.strictObject({ projectPaths: paths, capabilities: capabilities(["read", "create", "start"]) }).optional(),
    designs: z
      .strictObject({
        chatId: z.string().min(1).max(8192),
        designIds: z.union([z.literal("*"), z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(1000)]),
        capabilities: capabilities(["read", "write"]),
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Select at least one tool group");
const configurationSchema = z.strictObject({ label: z.string().trim().min(1).max(120), grants: grantsSchema, expiresAt: z.iso.datetime().optional() });
const hash = (text) => createHash("sha256").update(text).digest("hex");

// Each small write is synchronous and fsynced: memory and durable authorization cannot race.
function privateJson(directory, name, fallback) {
  preparePrivateDirectory(directory);
  const file = path.join(directory, name);
  return {
    read() {
      try {
        assertPrivate(file);
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return structuredClone(fallback);
        throw error;
      }
    },
    write(value) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      let fd;
      try {
        fd = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify(value));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        if (process.platform === "win32") windowsAcl(temporary, { mode: "protect" });
        fs.renameSync(temporary, file);
        if (process.platform !== "win32") {
          const directoryFd = fs.openSync(directory, "r");
          try {
            fs.fsyncSync(directoryFd);
          } finally {
            fs.closeSync(directoryFd);
          }
        }
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(temporary, { force: true });
      }
    },
  };
}

function createLocalMcpStore({ directory, now = Date.now }) {
  const file = privateJson(directory, "connections.json", { version: 1, connections: [] });
  let state = file.read();
  if (state.version !== 1 || !Array.isArray(state.connections)) throw Error("Invalid local MCP connection store");
  for (const connection of state.connections)
    configurationSchema.parse({ label: connection.label, grants: connection.grants, ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}) });
  const publicRecord = ({ tokenHash: _tokenHash, ...record }) => structuredClone(record);
  const active = (record) => record && !record.revokedAt && (!record.expiresAt || Date.parse(record.expiresAt) > now());
  const get = (id) => {
    const record = state.connections.find((item) => item.id === id);
    if (!active(record)) throw Error("Connection expired or revoked");
    return publicRecord(record);
  };
  const save = (connections) => {
    const next = { ...state, connections };
    file.write(next);
    state = next;
  };
  const replace = (id, update) => {
    get(id);
    const record = state.connections.find((item) => item.id === id);
    const next = { ...record, ...update, revision: record.revision + 1 };
    save(state.connections.map((item) => (item.id === id ? next : item)));
    return publicRecord(next);
  };
  return {
    get,
    list: () => state.connections.map(publicRecord),
    create(input, { clientId } = {}) {
      const config = configurationSchema.parse(input);
      if (config.expiresAt && Date.parse(config.expiresAt) <= now()) throw Error("Expiration must be in the future");
      const token = randomBytes(32).toString("base64url");
      const record = {
        ...config,
        ...(clientId ? { clientId } : {}),
        id: randomUUID(),
        revision: 1,
        createdAt: new Date(now()).toISOString(),
        tokenHash: hash(token),
      };
      save([...state.connections, record]);
      return { connection: publicRecord(record), token };
    },
    update(id, input) {
      const config = configurationSchema.parse(input);
      return replace(id, { ...config, expiresAt: config.expiresAt });
    },
    rotate(id) {
      const token = randomBytes(32).toString("base64url");
      return { connection: replace(id, { tokenHash: hash(token) }), token };
    },
    revoke(id) {
      // Revocation is idempotent, including an expired connection.
      const record = state.connections.find((item) => item.id === id);
      if (!record) throw Error("Unknown connection");
      if (!record.revokedAt)
        save(state.connections.map((item) => (item.id === id ? { ...item, revision: item.revision + 1, revokedAt: new Date(now()).toISOString() } : item)));
    },
    authenticate(token) {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw Error("Unauthorized");
      const record = state.connections.find((item) => item.tokenHash === hash(token));
      if (!active(record)) throw Error("Unauthorized");
      return publicRecord(record);
    },
  };
}
module.exports = { createLocalMcpStore, configurationSchema, privateJson, hash };

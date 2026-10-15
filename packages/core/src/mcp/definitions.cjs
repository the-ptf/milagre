const fs = require("node:fs");

// One MCP server definition (the sheet's shape, @milagre/shared/mcp McpServerDefinition) in each provider's
// own config shape, and back.

const MASK = "••••••"; // MCP_SECRET_MASK in @milagre/shared/mcp
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)])) : {});
const pairs = (record) => Object.entries(record).map(([name, value]) => ({ name, value }));
const withNonEmpty = (key, record) => (Object.keys(record).length ? { [key]: record } : {});

function toClaudeConfig(def) {
  if (def.type === "stdio") return { type: "stdio", command: def.command, args: def.args, ...withNonEmpty("env", def.env) };
  return { type: def.type, url: def.url, ...withNonEmpty("headers", def.headers) };
}

function toCodexConfig(def) {
  if (def.type === "stdio") return { command: def.command, args: def.args, ...withNonEmpty("env", def.env) };
  return { url: def.url, ...withNonEmpty("http_headers", def.headers) };
}

function toAcpServer(def) {
  if (def.type === "stdio") return { name: def.name, command: def.command, args: def.args, env: pairs(def.env) };
  return { type: def.type, name: def.name, url: def.url, headers: pairs(def.headers) };
}

function fromClaudeConfig(name, config) {
  if (!isObject(config)) return null;
  if (config.type === "http" || config.type === "sse") return { name, type: config.type, url: String(config.url ?? ""), headers: strings(config.headers) };
  if ((config.type === undefined || config.type === "stdio") && typeof config.command === "string")
    return { name, type: "stdio", command: config.command, args: Array.isArray(config.args) ? config.args.map(String) : [], env: strings(config.env) };
  return null;
}

function fromCodexConfig(name, config) {
  if (!isObject(config)) return null;
  if (typeof config.url === "string") return { name, type: "http", url: config.url, headers: strings(config.http_headers) };
  if (typeof config.command === "string")
    return { name, type: "stdio", command: config.command, args: Array.isArray(config.args) ? config.args.map(String) : [], env: strings(config.env) };
  return null;
}

const maskRecord = (record) => Object.fromEntries(Object.keys(record).map((key) => [key, MASK]));
function maskDefinition(def) {
  return def.type === "stdio" ? { ...def, env: maskRecord(def.env) } : { ...def, headers: maskRecord(def.headers) };
}

const unmaskRecord = (record, stored = {}) =>
  Object.fromEntries(
    Object.entries(record).flatMap(([key, value]) => (value !== MASK ? [[key, value]] : Object.hasOwn(stored, key) ? [[key, stored[key]]] : [])),
  );
function unmaskDefinition(def, previous) {
  if (def.type === "stdio") return { ...def, env: unmaskRecord(def.env, previous?.type === "stdio" ? previous.env : {}) };
  return { ...def, headers: unmaskRecord(def.headers, previous && previous.type !== "stdio" ? previous.headers : {}) };
}

function claudeConfigNames(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Set(isObject(value.mcpServers) ? Object.keys(value.mcpServers) : []);
  } catch {
    return new Set();
  }
}

// Collects the server name from every [mcp_servers.<name>] or [mcp_servers.<name>.<sub>] header, bare or quoted,
// with an optional trailing comment. Dotted keys (mcp_servers.x.command = ...) and inline tables are not supported.
const CODEX_SERVER_HEADER = /^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\.[^\]]*)?\][ \t]*(?:#.*)?$/gm;
function codexConfigNames(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return new Set([...text.matchAll(CODEX_SERVER_HEADER)].map((match) => match[1] ?? match[2] ?? match[3]));
  } catch {
    return new Set();
  }
}

const detailOf = (def) => (def.type === "stdio" ? [def.command, ...def.args].join(" ") : def.url);

module.exports = {
  MASK,
  toClaudeConfig,
  toCodexConfig,
  toAcpServer,
  fromClaudeConfig,
  fromCodexConfig,
  maskDefinition,
  unmaskDefinition,
  claudeConfigNames,
  codexConfigNames,
  detailOf,
};

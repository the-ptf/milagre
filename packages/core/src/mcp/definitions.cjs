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
  return def.type === "stdio" ? { ...def, args: maskArgs(def.args), env: maskRecord(def.env) } : { ...def, headers: maskRecord(def.headers) };
}

const unmaskRecord = (record, stored = {}) =>
  Object.fromEntries(
    Object.entries(record).flatMap(([key, value]) => (value !== MASK ? [[key, value]] : Object.hasOwn(stored, key) ? [[key, stored[key]]] : [])),
  );
// True when the edit sends back a masked value the stored record would fill in.
const restores = (record, stored) => Object.entries(record).some(([key, value]) => value === MASK && Object.hasOwn(stored, key));
function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Secret arguments come back in their masked form. They are put back only onto an unchanged argument list: the same
// command, the same length, and every position either the stored argument, its masked form (restored), or a new
// value for a secret that keeps what precedes the mask ("--token=", "Authorization: "). Removing, adding or
// reordering arguments while a mask is still there would move a stored secret under another flag, so it is refused.
const ARGS_CHANGED = "Enter the argument values again after changing the arguments.";
function unmaskArgs(args, stored, sameCommand) {
  if (!args.some((arg) => arg.includes(MASK))) return args;
  if (!stored || !sameCommand || args.length !== stored.args.length) throw new Error(ARGS_CHANGED);
  const masked = maskArgs(stored.args);
  return args.map((arg, index) => {
    const original = stored.args[index];
    if (arg === original) return arg;
    const secret = masked[index] !== original;
    if (secret && arg === masked[index]) return original;
    if (secret && !arg.includes(MASK) && arg.startsWith(masked[index].slice(0, masked[index].indexOf(MASK)))) return arg;
    throw new Error(ARGS_CHANGED);
  });
}

/** The definition to write: masked values sent back from a screen become the stored ones. Stored secrets never follow
 * the server to a new origin (URL) or a new command (stdio): those edits must type the values again. */
function unmaskDefinition(def, previous) {
  if (def.type === "stdio") {
    const stored = previous?.type === "stdio" ? previous : null;
    const sameCommand = Boolean(stored) && stored.command === def.command;
    if (stored && !sameCommand && restores(def.env, stored.env)) throw new Error("Enter the variable values again for the new command.");
    return { ...def, args: unmaskArgs(def.args, stored, sameCommand), env: sameCommand ? unmaskRecord(def.env, stored.env) : unmaskRecord(def.env) };
  }
  const stored = previous && previous.type !== "stdio" ? previous : null;
  const sameOrigin = Boolean(stored) && originOf(def.url) !== null && originOf(def.url) === originOf(stored.url);
  if (stored && !sameOrigin && restores(def.headers, stored.headers)) throw new Error("Enter the header values again for the new address.");
  return { ...def, headers: sameOrigin ? unmaskRecord(def.headers, stored.headers) : unmaskRecord(def.headers) };
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

const KEY_WORD = /(^|[-_])key([-_]|$)/i;
// A flag name is secret when, with dashes and underscores removed, it holds a secret word (so compact names such
// as --apikey and --githubtoken match), or "auth" (only --author and --authors are not), or "key" as a whole word
// (--key, --api-key).
function secretFlag(flag) {
  const name = flag.replace(/^-+/, "");
  const compact = name.toLowerCase().replace(/[-_]/g, "");
  return (
    /token|secret|password|passwd|apikey|credential/.test(compact) ||
    (compact.includes("auth") && compact !== "author" && compact !== "authors") ||
    KEY_WORD.test(name)
  );
}
// curl-style header arguments (-H "Authorization: Bearer x", --header=Cookie: s=1): the value after the first ":"
// is masked when the header's name looks secret.
const HEADER_FLAGS = new Set(["-H", "--header"]);
const SECRET_HEADER = /auth|token|key|secret|cookie|password|credential/i;
function maskHeaderArg(value) {
  const colon = value.indexOf(":");
  return colon > 0 && SECRET_HEADER.test(value.slice(0, colon)) ? `${value.slice(0, colon)}: ${MASK}` : value;
}
/** The arguments with every secret value masked: a secret flag's value (--token x, --token=x) and a secret header's. */
function maskArgs(args) {
  const shown = [];
  let next = null; // what the previous flag says this argument is: "secret" or "header"
  for (const arg of Array.isArray(args) ? args.map(String) : []) {
    if (next) {
      shown.push(next === "header" ? maskHeaderArg(arg) : MASK);
      next = null;
      continue;
    }
    const equals = arg.startsWith("-") ? arg.indexOf("=") : -1;
    if (equals > 0) {
      const flag = arg.slice(0, equals);
      const value = arg.slice(equals + 1);
      shown.push(HEADER_FLAGS.has(flag) ? `${flag}=${maskHeaderArg(value)}` : secretFlag(flag) ? `${flag}=${MASK}` : arg);
    } else {
      shown.push(arg);
      next = HEADER_FLAGS.has(arg) ? "header" : arg.startsWith("-") && secretFlag(arg) ? "secret" : null;
    }
  }
  return shown;
}
const WEB_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const SCHEME_AND_USERINFO = /^([a-z][a-z0-9+.-]*:)?(\/\/)?[^/@]*@/i;

// The one-line description of a server that travels to phones and paired Macs. Takes a definition or a raw
// { url } / { command, args } config. Raw URLs and args can carry secrets, so userinfo, query and fragment are
// dropped from a URL, and the value of a secret-looking flag is masked in a command line.
function safeDetail(config) {
  if (!isObject(config)) return null;
  if (typeof config.url === "string") {
    try {
      const url = new URL(config.url);
      if (WEB_PROTOCOLS.has(url.protocol)) return url.pathname === "/" && !config.url.endsWith("/") ? url.origin : url.origin + url.pathname;
    } catch {
      // not an absolute URL: fall through
    }
    // No scheme, or an unknown one (where URL parses "user:pass@host" as an opaque scheme): cut by hand.
    return config.url.split(/[?#]/)[0].replace(SCHEME_AND_USERINFO, "");
  }
  if (typeof config.command !== "string") return null;
  return [config.command, ...maskArgs(config.args)].join(" ");
}

const detailOf = safeDetail;

module.exports = {
  MASK,
  toClaudeConfig,
  toCodexConfig,
  toAcpServer,
  fromClaudeConfig,
  fromCodexConfig,
  maskDefinition,
  unmaskDefinition,
  maskArgs,
  claudeConfigNames,
  codexConfigNames,
  detailOf,
  safeDetail,
};

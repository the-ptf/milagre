const { ConnectorError } = require("./callback.cjs");

const MAX_NAME = 60;
const ID_LENGTH = 16;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function connectorUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new ConnectorError("Enter the server's https address.", "invalid");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))
    throw new ConnectorError("Use an https address. Plain http only works for a server on this computer.", "invalid");
  if (url.username || url.password) throw new ConnectorError("Take the user name and password out of the address.", "invalid");
  url.hash = "";
  return url.href;
}

function connectorName(value) {
  const name = String(value ?? "").trim();
  if (!name || name.length > MAX_NAME) throw new ConnectorError(`Name the connector in up to ${MAX_NAME} characters.`, "invalid");
  return name;
}

function idFor(name, taken) {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "");
  const trim = (value, length) => value.slice(0, length).replace(/_+$/, "");
  const base = trim(slug, ID_LENGTH) || "connector";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${trim(base, ID_LENGTH - String(n).length - 1)}_${n}`;
    if (!taken.has(id)) return id;
  }
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_MASK = "••••••";

function keepStored(name, item, stored) {
  if (item !== HEADER_MASK) return String(item);
  if (!Object.hasOwn(stored, name)) throw new ConnectorError(`Enter the value for ${name} again.`, "invalid");
  return stored[name];
}

function connectorHeaders(value, stored = {}) {
  if (value === undefined) return undefined;
  const entries = Object.entries(value && typeof value === "object" ? value : {}).filter(([name, item]) => name && item !== "");
  for (const [name] of entries) if (!HEADER_NAME.test(name)) throw new ConnectorError(`${JSON.stringify(name)} isn't a header name.`, "invalid");
  return Object.fromEntries(entries.map(([name, item]) => [name, keepStored(name, item, stored)]));
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Environment for a command connector; like headers, a masked value keeps the stored one. */
function connectorEnv(value, stored = {}) {
  if (value === undefined) return undefined;
  const entries = Object.entries(value && typeof value === "object" ? value : {}).filter(([name, item]) => name && item !== "");
  for (const [name] of entries) if (!ENV_NAME.test(name)) throw new ConnectorError(`${JSON.stringify(name)} isn't an environment variable name.`, "invalid");
  return Object.fromEntries(entries.map(([name, item]) => [name, keepStored(name, item, stored)]));
}

function connectorCommand(command, args) {
  const program = String(command ?? "").trim();
  if (!program) throw new ConnectorError("Enter the command that starts the server.", "invalid");
  const list = Array.isArray(args) ? args.map(String) : [];
  return { command: program, args: list };
}

module.exports = { connectorUrl, connectorName, connectorHeaders, connectorEnv, connectorCommand, idFor };

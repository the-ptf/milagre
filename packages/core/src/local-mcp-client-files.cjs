const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const jsonc = require("jsonc-parser");
const toml = require("smol-toml");
const { windowsAcl } = require("./private-files.cjs");
const NAME = "milagre-local";
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function clientCatalog({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const absolute = (value, fallback) => (value && path.isAbsolute(value) ? value : fallback);
  const config = absolute(env.XDG_CONFIG_HOME, path.join(home, ".config"));
  return [
    {
      id: "claude-code",
      label: "Claude Code CLI",
      configPath: env.CLAUDE_CONFIG_DIR
        ? path.join(absolute(env.CLAUDE_CONFIG_DIR, path.join(home, ".claude")), ".claude.json")
        : path.join(home, ".claude.json"),
    },
    { id: "codex", label: "Codex CLI", configPath: path.join(absolute(env.CODEX_HOME, path.join(home, ".codex")), "config.toml"), format: "toml" },
    { id: "gemini", label: "Gemini CLI", configPath: path.join(home, ".gemini/settings.json") },
    { id: "antigravity", label: "Antigravity", configPath: path.join(home, ".gemini/config/mcp_config.json") },
    {
      id: "opencode",
      label: "OpenCode CLI",
      configPath: absolute(
        env.OPENCODE_CONFIG,
        path.join(config, "opencode", fs.existsSync(path.join(config, "opencode/opencode.jsonc")) ? "opencode.jsonc" : "opencode.json"),
      ),
      root: "mcp",
    },
    { id: "kiro", label: "Kiro CLI", configPath: path.join(home, ".kiro/settings/mcp.json") },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      configPath: path.join(
        platform === "win32" ? absolute(env.APPDATA, path.join(home, "AppData/Roaming")) : path.join(home, "Library/Application Support"),
        "Claude/claude_desktop_config.json",
      ),
      unavailable: !["darwin", "win32"].includes(platform) ? "Claude Desktop setup is available on macOS and Windows." : undefined,
    },
  ];
}

function assertPath(file) {
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw Error("Client configuration uses a symbolic link. Use custom configuration instead.");
      if (cursor === file && (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())))
        throw Error("Client configuration must be a file owned by you.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (cursor === path.dirname(cursor)) break;
  }
}
function readText(file) {
  assertPath(file);
  try {
    if (fs.statSync(file).size > 16 * 1024 * 1024) throw Error("Client configuration is too large to edit automatically.");
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function readConfig(client) {
  const before = readText(client.configPath);
  const text = before ?? (client.format === "toml" ? "" : "{}\n");
  let value;
  try {
    if (client.format === "toml") value = toml.parse(text);
    else {
      const errors = [];
      const tree = jsonc.parseTree(text, errors, { allowTrailingComma: true });
      const check = (node) => {
        if (node?.type === "object") {
          const keys = node.children.map((p) => p.children[0].value);
          if (new Set(keys).size !== keys.length) throw Error();
        }
        for (const child of node?.children ?? []) check(child);
      };
      check(tree);
      if (errors.length || !tree) throw Error();
      value = jsonc.getNodeValue(tree);
    }
    const root = client.format === "toml" ? "mcp_servers" : (client.root ?? "mcpServers");
    if (!object(value) || (value[root] !== undefined && !object(value[root]))) throw Error();
    return { before, text, value, root, entry: value[root]?.[NAME] };
  } catch {
    throw Error("Client configuration is invalid or ambiguous. Fix it before connecting Milagre.");
  }
}
function prepareEdit(client, read, entry) {
  let after;
  if (client.format === "toml") {
    const lines = read.text.split("\n");
    let removing = false;
    const kept = [];
    for (const line of lines) {
      if (/^\s*\[/.test(line)) removing = /^\s*\[\s*mcp_servers\s*\.\s*(?:milagre-local|"milagre-local"|'milagre-local')(?:\s*\.|\s*\])/.test(line);
      if (!removing) kept.push(line);
    }
    after = kept.join("\n");
    if (entry)
      after += `\n[mcp_servers."${NAME}"]\nurl = ${JSON.stringify(entry.url)}\nhttp_headers = { Authorization = ${JSON.stringify(entry.http_headers.Authorization)} }\n`;
    let parsed;
    try {
      parsed = toml.parse(after);
    } catch {
      throw Error("Cannot safely edit this TOML layout. Use custom configuration instead.");
    }
    const expected = structuredClone(read.value);
    expected.mcp_servers ??= {};
    if (entry) expected.mcp_servers[NAME] = entry;
    else delete expected.mcp_servers[NAME];
    if (!Object.keys(expected.mcp_servers).length) delete expected.mcp_servers;
    if (parsed.mcp_servers && !Object.keys(parsed.mcp_servers).length) delete parsed.mcp_servers;
    if (!equal(parsed, expected)) throw Error("Cannot safely edit this TOML layout. Use custom configuration instead.");
  } else
    after = jsonc.applyEdits(
      read.text,
      jsonc.modify(read.text, [read.root, NAME], entry, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }),
    );
  return () => {
    if (readText(client.configPath) !== read.before) throw Error("Client configuration changed. Refresh and try again.");
    if (after === read.text) return;
    fs.mkdirSync(path.dirname(client.configPath), { recursive: true, mode: 0o700 });
    assertPath(client.configPath);
    const temp = `${client.configPath}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, after);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (process.platform === "win32") windowsAcl(temp, { mode: "protect" });
      if (readText(client.configPath) !== read.before) throw Error("Client configuration changed. Refresh and try again.");
      fs.renameSync(temp, client.configPath);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temp, { force: true });
    }
  };
}
function clientEntry(id, url, token) {
  const headers = { Authorization: `Bearer ${token}` };
  if (id === "codex") return { url, http_headers: headers };
  if (id === "gemini") return { httpUrl: url, headers };
  if (id === "antigravity") return { serverUrl: url, headers };
  if (id === "opencode") return { type: "remote", url, headers, oauth: false, enabled: true };
  if (id === "claude-desktop")
    return {
      command: process.execPath,
      args: [path.join(__dirname, "local-mcp-stdio.cjs")],
      env: { ELECTRON_RUN_AS_NODE: "1", MILAGRE_MCP_URL: url, MILAGRE_MCP_TOKEN: token },
    };
  return { ...(id === "claude-code" ? { type: "http" } : {}), url, headers };
}
const entryToken = (entry) =>
  entry?.env?.MILAGRE_MCP_TOKEN ?? /^Bearer (\S+)$/.exec(entry?.headers?.Authorization ?? entry?.http_headers?.Authorization ?? "")?.[1];
module.exports = { clientCatalog, readConfig, prepareEdit, clientEntry, entryToken, canonical };

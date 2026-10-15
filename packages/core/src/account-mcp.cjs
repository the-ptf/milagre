const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// An added Claude or Codex Account runs from its own config folder, but the MCP servers the user set up
// belong to the connected CLI account: Claude keeps them in .claude.json, which an Account never copies,
// and Codex copied config.toml once, when the Account was added. Each time an Account's environment is
// built, the connected account's servers are merged into the Account's config. A server of the same name
// takes the connected account's definition; a server only the Account has stays.

function writeIfChanged(file, before, after) {
  if (after === before) return;
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, after, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// The names copied last time, beside the target config, so a server removed from the source can be removed again
// without touching servers the account added itself.
const recordFile = (targetFile) => path.join(path.dirname(targetFile), "milagre-inherited-mcp.json");
function readRecorded(targetFile) {
  try {
    const names = JSON.parse(fs.readFileSync(recordFile(targetFile), "utf8")).names;
    return new Set(Array.isArray(names) ? names : []);
  } catch {
    return new Set();
  }
}
function writeRecorded(targetFile, names) {
  const file = recordFile(targetFile);
  writeIfChanged(file, readText(file), `${JSON.stringify({ names: [...names].toSorted() })}\n`);
}

// User servers sit at the top level of .claude.json, local ones under projects[path]. The Account's file
// is written by Claude Code at sign-in; before that there is nothing to merge into.
function inheritClaudeMcp(sourceFile, targetFile) {
  const sourceText = readText(sourceFile);
  const targetText = readText(targetFile);
  if (sourceText === null || targetText === null) return;
  const source = JSON.parse(sourceText);
  const target = JSON.parse(targetText);
  if (!isObject(source) || !isObject(target)) return;
  const sourceNames = new Set(isObject(source.mcpServers) ? Object.keys(source.mcpServers) : []);
  if (isObject(target.mcpServers)) for (const name of readRecorded(targetFile)) if (!sourceNames.has(name)) delete target.mcpServers[name];
  if (isObject(source.mcpServers) && Object.keys(source.mcpServers).length)
    target.mcpServers = { ...(isObject(target.mcpServers) ? target.mcpServers : {}), ...source.mcpServers };
  for (const [project, settings] of Object.entries(isObject(source.projects) ? source.projects : {})) {
    if (!isObject(settings?.mcpServers) || !Object.keys(settings.mcpServers).length) continue;
    if (!isObject(target.projects)) target.projects = {};
    const current = isObject(target.projects[project]) ? target.projects[project] : {};
    target.projects[project] = { ...current, mcpServers: { ...(isObject(current.mcpServers) ? current.mcpServers : {}), ...settings.mcpServers } };
  }
  const next = JSON.stringify(target, null, 2);
  // Unchanged servers leave the file alone, whatever formatting Claude Code wrote it with.
  if (JSON.stringify(JSON.parse(targetText), null, 2) !== next) writeIfChanged(targetFile, targetText, next);
  writeRecorded(targetFile, sourceNames);
}

// The server a TOML table header belongs to: [mcp_servers.pencil] and [mcp_servers.pencil.env] are both
// "pencil". Anything else, [mcp_servers] alone included, belongs to no server.
const SERVER_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
const HEADER = /^\s*\[/;

// The text before the first table, then each table with the lines up to the next header.
function tomlSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let current = { server: null, lines: [] };
  for (const line of lines) {
    if (HEADER.test(line)) {
      sections.push(current);
      const name = SERVER_HEADER.exec(line)?.[1];
      current = { server: name ? name.replace(/^["']|["']$/g, "") : null, lines: [] };
    }
    current.lines.push(line);
  }
  sections.push(current);
  return sections;
}

function inheritCodexMcp(sourceFile, targetFile) {
  const sourceText = readText(sourceFile);
  const targetText = readText(targetFile);
  if (sourceText === null || targetText === null) return;
  const inherited = tomlSections(sourceText).filter((section) => section.server);
  const names = new Set(inherited.map((section) => section.server));
  // A server copied last time that the source no longer has goes, sub-tables included.
  const removed = new Set([...readRecorded(targetFile)].filter((name) => !names.has(name)));
  if (!inherited.length && !removed.size) return;
  const kept = tomlSections(targetText).filter((section) => !names.has(section.server) && !removed.has(section.server));
  const body = kept
    .map((section) => section.lines.join("\n"))
    .join("\n")
    .replace(/\n*$/, "\n");
  const added = inherited.map((section) => section.lines.join("\n").replace(/\n*$/, "\n")).join("\n");
  writeIfChanged(targetFile, targetText, inherited.length ? `${body}\n${added}` : body);
  writeRecorded(targetFile, names);
}

function inheritMcp(provider, { sourceDir, targetDir, home, configDirSet }) {
  if (provider === "claude") {
    // Without CLAUDE_CONFIG_DIR, Claude Code keeps .claude.json in the home folder, not in ~/.claude.
    const sourceFile = configDirSet ? path.join(sourceDir, ".claude.json") : path.join(home, ".claude.json");
    inheritClaudeMcp(sourceFile, path.join(targetDir, ".claude.json"));
  } else if (provider === "codex") inheritCodexMcp(path.join(sourceDir, "config.toml"), path.join(targetDir, "config.toml"));
}

module.exports = { inheritMcp, inheritClaudeMcp, inheritCodexMcp };

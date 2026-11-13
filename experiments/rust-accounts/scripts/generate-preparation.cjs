// Real Node preparation and MCP transforms in fresh synthetic copies. No process/login/network.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createAccounts } = require("../../../packages/core/src/accounts.cjs");
const { inheritCodexMcp, inheritClaudeMcp } = require("../../../packages/core/src/account-mcp.cjs");
const root = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "milagre-preparation-oracle-"));
const stop = new Error("synthetic: stop before login");
const preparations = [],
  mcp = [];
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
}
function tree(dir, base) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name),
      stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) out[name] = { link: fs.readlinkSync(file).replaceAll(base, "@ROOT@") };
    else if (stat.isDirectory()) out[name] = { directory: tree(file, base) };
    else out[name] = { text: fs.readFileSync(file, "utf8").replaceAll(base, "@ROOT@") };
  }
  return out;
}
async function preparation(provider, sources) {
  const dir = path.join(root, `prep-${preparations.length}`),
    home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const [key, file] of Object.entries({
    codex_config: ".codex/config.toml",
    codex_instructions: ".codex/AGENTS.md",
    claude_settings: ".claude/settings.json",
    claude_instructions: ".claude/CLAUDE.md",
    claude_mcp: ".claude.json",
  })) {
    if (sources[key] != null) write(path.join(home, file), sources[key]);
  }
  for (const [key, folder] of [
    ["gemini_config_skills", "config/skills"],
    ["gemini_cli_skills", "antigravity-cli/skills"],
  ]) {
    if (sources[key]) fs.mkdirSync(path.join(home, ".gemini", folder), { recursive: true, mode: 0o700 });
  }
  const accounts = createAccounts({
    dataDir: dir,
    home,
    env: { HOME: home },
    cli: async () => ({ command: "synthetic-never-executed" }),
    inspect: async () => {
      throw new Error("inspection forbidden");
    },
    spawn: () => {
      throw stop;
    },
    signInAntigravity: () => {
      throw stop;
    },
  });
  const result = { provider, sources };
  try {
    await accounts.add(provider, "Synthetic");
    throw new Error("Login hook was not reached");
  } catch (error) {
    if (error !== stop) result.error = error.message;
  }
  const file = path.join(dir, "accounts/accounts.json");
  if (fs.existsSync(file)) {
    const account = JSON.parse(fs.readFileSync(file, "utf8")).accounts[0];
    result.profile = tree(path.join(dir, "accounts", account.id), dir);
    result.default = tree(path.join(dir, "accounts/antigravity-default"), dir);
  }
  accounts.close();
  preparations.push(result);
}
function inherit(provider, source, target, previous = null) {
  const dir = path.join(root, `mcp-${mcp.length}`),
    sourceFile = path.join(dir, "source/config"),
    targetFile = path.join(dir, "target/config"),
    record = path.join(dir, "target/milagre-inherited-mcp.json");
  if (source !== null) write(sourceFile, source);
  if (target !== null) write(targetFile, target);
  if (previous !== null) write(record, previous);
  const result = { provider, source, target, previous };
  const beforeTarget = fs.existsSync(targetFile) ? fs.statSync(targetFile).ino : null,
    beforeRecord = fs.existsSync(record) ? fs.statSync(record).ino : null;
  try {
    (provider === "codex" ? inheritCodexMcp : inheritClaudeMcp)(sourceFile, targetFile);
  } catch {
    result.error = true;
  }
  result.next = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, "utf8") : null;
  result.record = fs.existsSync(record) ? fs.readFileSync(record, "utf8") : null;
  result.targetChanged = fs.existsSync(targetFile) && fs.statSync(targetFile).ino !== beforeTarget;
  result.recordChanged = fs.existsSync(record) && fs.statSync(record).ino !== beforeRecord;
  mcp.push(result);
}
async function main() {
  for (const config of [
    null,
    "",
    '# comment\nmodel = "x"\n',
    'cli_auth_credentials_store = "keyring"\n[model]\ncli_auth_credentials_store = "table"\n',
    '# keep\n\nsqlite_home = "custom"\ncli_auth_credentials_store="auto"\n[mcp_servers.a]\ncommand="fake"\n',
    'before=1\rcli_auth_credentials_store="a"\r[foo]\rx=1',
    'before=1\u2028cli_auth_credentials_store="a"\u2029[foo]\nx=1',
    '\ufeffcli_auth_credentials_store="auto"\n\n# hi\n[unknown]\nx=2\n',
    'cli_auth_credentials_store="a"\ncli_auth_credentials_store = "b"\n',
    '[mcp_servers."quoted.name"] # comment\ncommand="synthetic"\n[mcp_servers."quoted.name".env]\nX="v"\n[unknown]\nkeep=1\n',
    'sqlite_home="old"\r\ncli_auth_credentials_store="a"\r\n[other]\r\nx=1\r\n',
  ]) {
    await preparation("codex", { codex_config: config, codex_instructions: "# synthetic instructions\n" });
  }
  for (const settings of [
    null,
    '{"apiKeyHelper":"synthetic","theme":"dark","nested":{"apiKeyHelper":"keep"}}',
    '{ "unknown": true, "2":"two","1":"one", "n":1e-7, "large":9007199254740993 }',
    '["unchanged",2]',
    '"scalar"',
    "null",
    '{ // invalid JSON comment\n"x":1}',
    '{"__proto__":{"safe":"unknown"},"apiKeyHelper":null}',
  ]) {
    await preparation("claude", {
      claude_settings: settings,
      claude_instructions: "synthetic Claude instructions\n",
      claude_mcp: '{"mcpServers":{"test":{"command":"never-run"}},"identity":"must-not-copy"}',
    });
  }
  for (const a of [false, true]) for (const b of [false, true]) await preparation("antigravity", { gemini_config_skills: a, gemini_cli_skills: b });
  const codex = [
    [null, "x=1", null],
    ['[mcp_servers.a]\ncommand="one"\n', null, null],
    ["# empty\n", "# unchanged\n", null],
    ['[mcp_servers.a]\ncommand="one"\n', 'mine=1\n[mcp_servers.a]\ncommand="old"\n[mcp_servers.keep]\nx=2\n', null],
    ['[mcp_servers."a.b"] # comment\ncommand="x"\n[mcp_servers."a.b".env]\nK="v"\n', "[mcp_servers.keep]\nk=1\n", null],
    ["[mcp_servers.a]\nx=1\n", '[mcp_servers.removed]\nx=2\n[mcp_servers.removed.env]\nA="b"\n[mcp_servers.mine]\nx=3\n', '{"names":["removed"]}'],
    ["# removed all\n", "[mcp_servers.removed]\nx=2\n[mcp_servers.mine]\nx=3\n", '{"names":["removed"]}'],
    ['[mcp_servers]\ninline={command="x"}\n', "same", null],
    ['[mcp_servers."q\\\"uote"]\nx=1\n[mcp_servers.2]\nx=2\n[mcp_servers.10]\nx=3\n[mcp_servers.😀]\nx=4\n', "# unchanged\r\n", null],
    ["[mcp_servers.a]\r\nx=1\r\n", "[mcp_servers.a]\r\nx=2\r\n", "bad-json"],
    ["[mcp_servers.a]\nx=1\n", "\n[mcp_servers.a]\nx=1\n", '{"names":["a"]}\n'],
  ];
  codex.push(["# source", "# root\n[mcp_servers.keep]\nx=1\n[unknown]\nx=2\n", '{"names":[null,7,true,{}]}']);
  codex.push(["[mcp_servers.\"'quoted'\"]\nx=1\n", "", null]);
  codex.push(["# source", "# root", '{"names":[7]}']);
  codex.push(['[mcp_servers.""]\nx=1\n', "keep", null]);
  for (const args of codex) inherit("codex", ...args);
  const claude = [
    [null, '{"identity":"target"}', null],
    ["{}", null, null],
    ["[]", "{}", null],
    ["{}", "null", null],
    ["{bad", "{}", null],
    ["{}", "{bad", null],
    ['{"mcpServers":{"a":{"command":"new"}},"identity":"source"}', '{"identity":"target","mcpServers":{"a":{"command":"old"},"mine":{}},"other":5}', null],
    ['{"mcpServers":{}}', '{ "mcpServers":{"old":{},"mine":{}}, "keep":1 }', '{"names":["old"]}'],
    [
      '{"projects":{"/synthetic":{"mcpServers":{"a":{"command":"new"}}}}}',
      '{"projects":{"/synthetic":{"trust":true,"mcpServers":{"mine":{}}},"/other":{"x":1}},"mcpServers":{"keep":{}}}',
      null,
    ],
    ["{}", '{ "identity":"unchanged", "n":1e-7 }', null],
    [
      '{"mcpServers":{"2":{},"1":{},"😀":{},"\uffff":{},"__proto__":{"x":1}},"projects":{"__proto__":{"mcpServers":{"a":{}}}}}',
      '{"projects":{},"identity":"keep"}',
      null,
    ],
    ['{"projects":{"/x":{"mcpServers":{"z":{}}}},"mcpServers":{"a":{}}}', '{"projects":[1],"mcpServers":3,"2":2,"1":1,"big":9007199254740993}', null],
    ["{}", '{"projects":{"/x":{"mcpServers":{"old":{}}}}}', '{"names":["old",7,null]}'],
  ];
  claude.push(["{}", '{"mcpServers":{"7":{},"null":{},"true":{},"[object Object]":{},"a,b":{},"keep":{}}}', '{"names":[7,null,true,{},["a","b"]]}']);
  claude.push(['{"projects":{"__proto__":{"mcpServers":{"a":{}}}}}', '{"projects":{"__proto__":{"mcpServers":{"mine":{}},"unknown":1}},"zero":-0}', null]);
  for (const args of claude) inherit("claude", ...args);
  const file = path.join(__dirname, "../fixtures/preparation.json"),
    output = execFileSync(path.resolve(__dirname, "../../../node_modules/.bin/oxfmt"), ["--stdin-filepath", file], {
      input: JSON.stringify({ preparations, mcp }, null, 2) + "\n",
      encoding: "utf8",
    });
  if (process.argv.includes("--check")) assert.equal(fs.readFileSync(file, "utf8"), output);
  else fs.writeFileSync(file, output);
  console.log(`${preparations.length} actual Node profile preparations, ${mcp.length} MCP transforms`);
}
main()
  .finally(() => fs.rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

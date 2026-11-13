#!/usr/bin/env node
// Regenerates tests/fixtures/conformance.json from the Node Terminal owner (packages/core/src/terminals.cjs), so the
// Rust port answers every scripted command exactly as Milagre does today. Run from the repo root:
//   node experiments/rust-terminals/scripts/generate-conformance.cjs
// node-pty is never loaded: every scenario injects a fake PTY (the same shape as terminals.test.cjs's fakePty), and
// the Rust test replays the same operations against its own fake. Only temporary folders are created, and removed.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const root = path.resolve(__dirname, "../../..");
const { createTerminals, terminalEnvironment, terminalShell, terminalShells } = require(path.join(root, "packages/core/src/terminals.cjs"));
const output = path.join(__dirname, "../tests/fixtures/conformance.json");

// ---- Scripted owner scenarios -------------------------------------------------------------------------------------

const zshShell = { file: "/bin/zsh", args: ["-l"] };
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const call = (command, request) => ({ op: "call", command, request });
const scenarios = [
  {
    name: "open lists a login shell in the Chat's first Worktree",
    ops: [
      call("terminal:open", { chatId: "/p#1", cols: 120, rows: 30 }),
      { op: "state", pty: 0 },
      call("terminal:list", { chatId: "/p#1" }),
      call("terminal:list", { chatId: "/p#9" }),
    ],
  },
  {
    name: "a shared Chat opens only in its own Worktrees",
    ops: [
      call("terminal:open", { chatId: "link:abc#2", cwd: "$SECOND" }),
      call("terminal:open", { chatId: "link:abc#2", cwd: "$OUTSIDE" }),
      call("terminal:open", { chatId: "link:abc#2", cwd: 5 }),
      call("terminal:open", { chatId: "link:abc#2", cwd: null }),
      call("terminal:open", { chatId: "/p#404" }),
      call("terminal:open", { chatId: "/p#empty" }),
      call("terminal:open", { chatId: "/p#gone" }),
      call("terminal:open", {}),
      call("terminal:open", { chatId: "" }),
    ],
  },
  {
    name: "reads after an offset, and a reset for a late viewer",
    ops: [
      call("terminal:open", { chatId: "/p#1" }),
      { op: "emit", pty: 0, text: "hello " },
      { op: "emit", pty: 0, text: "world" },
      call("terminal:read", { terminalId: "$T0", after: 0 }),
      { op: "emit", pty: 0, text: "!" },
      call("terminal:read", { terminalId: "$T0", after: 11 }),
      call("terminal:read", { terminalId: "$T0", after: 99 }),
      call("terminal:read", { terminalId: "$T0", after: 12 }),
      { op: "emit", pty: 0, text: "" },
      call("terminal:read", { terminalId: "$T0", after: 12 }),
    ],
  },
  {
    name: "read limits hand output over in order and never split a character",
    options: { maxBufferChars: 14_000 },
    ops: [
      call("terminal:open", { chatId: "/p#1" }),
      { op: "emit", pty: 0, text: "a".repeat(4095) + "😀" + "b".repeat(5000) },
      call("terminal:read", { terminalId: "$T0", after: 0, limit: 4096 }),
      call("terminal:read", { terminalId: "$T0", after: 4095, limit: 8192 }),
      { op: "emit", pty: 0, text: "c".repeat(4000) },
      call("terminal:read", { terminalId: "$T0", after: 0, limit: 4096 }),
      { op: "emit", pty: 0, text: "d".repeat(4000) },
      call("terminal:read", { terminalId: "$T0", after: 1, limit: 4096 }),
      call("terminal:read", { terminalId: "$T0", after: 0, limit: 10 }),
      call("terminal:read", { terminalId: "$T0", after: 0, limit: 4095 }),
      call("terminal:read", { terminalId: "$T0", after: 0, limit: null }),
      call("terminal:read", { terminalId: "$T0", after: 0, limit: 4096.5 }),
    ],
  },
  {
    name: "a reset's newest part never starts inside a character",
    ops: [
      call("terminal:open", { chatId: "/p#1" }),
      { op: "emit", pty: 0, text: "😀" + "c".repeat(4095) },
      call("terminal:read", { terminalId: "$T0", after: 999_999, limit: 4096 }),
      { op: "emit", pty: 0, text: "ação 😀 中文\r\n" },
      call("terminal:read", { terminalId: "$T0", after: 4097 }),
      call("terminal:read", { terminalId: "$T0", after: 4097 + 5 }),
    ],
  },
  {
    name: "the buffer keeps only the newest lines",
    options: { maxBufferLines: 3 },
    ops: [
      call("terminal:open", { chatId: "/p#1" }),
      ...["a\n", "b\n", "c\n", "d\n"].map((text) => ({ op: "emit", pty: 0, text })),
      call("terminal:read", { terminalId: "$T0", after: 0 }),
      { op: "emit", pty: 0, text: "e\nf\ng\nh\n" },
      call("terminal:read", { terminalId: "$T0", after: 0 }),
    ],
  },
  {
    name: "a chunk larger than the buffer keeps its tail",
    options: { maxBufferChars: 4 },
    ops: [
      call("terminal:open", { chatId: "/p#1" }),
      { op: "emit", pty: 0, text: "abcdefgh" },
      call("terminal:read", { terminalId: "$T0", after: 0 }),
      { op: "emit", pty: 0, text: "ij" },
      call("terminal:read", { terminalId: "$T0", after: 8 }),
      call("terminal:read", { terminalId: "$T0", after: 0 }),
    ],
  },
  {
    name: "input, resize and close reach the shell",
    ops: [
      call("terminal:open", { chatId: "/p#1" }),
      call("terminal:input", { terminalId: "$T0", data: "ls\r" }),
      call("terminal:input", { terminalId: "$T0", data: "ação 😀" }),
      call("terminal:input", { terminalId: "$T0", data: "x".repeat(65_536) }),
      call("terminal:input", { terminalId: "$T0", data: "x".repeat(65_537) }),
      call("terminal:input", { terminalId: "$T0", data: 5 }),
      call("terminal:input", { terminalId: "$T0" }),
      call("terminal:resize", { terminalId: "$T0", cols: 100, rows: 40 }),
      call("terminal:resize", { terminalId: "$T0", cols: 100, rows: 40 }),
      call("terminal:resize", { terminalId: "$T0", cols: 0, rows: 40 }),
      call("terminal:resize", { terminalId: "$T0", cols: 1000, rows: 500 }),
      call("terminal:resize", { terminalId: "$T0", cols: 1001, rows: 500 }),
      call("terminal:resize", { terminalId: "$T0", cols: 10, rows: 501 }),
      call("terminal:resize", { terminalId: "$T0", cols: 10.5, rows: 5 }),
      call("terminal:resize", { terminalId: "$T0", cols: "10", rows: 5 }),
      call("terminal:resize", { terminalId: "$T0", cols: 2, rows: 1 }),
      { op: "state", pty: 0 },
      call("terminal:list", { chatId: "/p#1" }),
      call("terminal:close", { terminalId: "$T0" }),
      { op: "state", pty: 0 },
      call("terminal:list", { chatId: "/p#1" }),
      call("terminal:input", { terminalId: "$T0", data: "x" }),
      call("terminal:resize", { terminalId: "$T0", cols: 0, rows: 0 }),
      call("terminal:close", { terminalId: "$T0" }),
      call("terminal:read", { terminalId: "$T0", after: 0 }),
      call("terminal:read", { terminalId: "not-an-id", after: 3 }),
      call("terminal:input", { terminalId: "not-an-id", data: "x" }),
      call("terminal:read", { terminalId: "$T0", after: -1 }),
      call("terminal:read", { terminalId: "$T0", after: 1.5 }),
      call("terminal:read", { terminalId: "$T0", after: "0" }),
      call("terminal:read", { terminalId: "$T0" }),
    ],
  },
  {
    name: "open sizes outside the limits fall back to 80x24",
    ops: [
      call("terminal:open", { chatId: "/p#1", cols: 1, rows: 0 }),
      call("terminal:open", { chatId: "/p#1", cols: 80.5, rows: 501 }),
      call("terminal:open", { chatId: "/p#1", cols: 1000, rows: 500 }),
      call("terminal:open", { chatId: "/p#1", cols: 2, rows: 1 }),
      call("terminal:open", { chatId: "/p#1", cols: "100", rows: -5 }),
    ],
  },
  {
    name: "a shell that exits ends its Terminal",
    ops: [
      call("terminal:open", { chatId: "/p#1" }),
      { op: "emit", pty: 0, text: "bye" },
      call("terminal:read", { terminalId: "$T0", after: 0 }),
      { op: "exit", pty: 0 },
      call("terminal:read", { terminalId: "$T0", after: 3 }),
      call("terminal:list", { chatId: "/p#1" }),
      call("terminal:input", { terminalId: "$T0", data: "x" }),
      { op: "shells" },
    ],
  },
  {
    name: "archiving a Chat ends only its own Terminals",
    ops: [
      call("terminal:open", { chatId: "/p#1" }),
      call("terminal:open", { chatId: "link:abc#2" }),
      call("terminal:open", { chatId: "link:abc#2", cwd: "$SECOND" }),
      { op: "shells" },
      { op: "closeChat", chat: "/p#1" },
      { op: "state", pty: 0 },
      { op: "state", pty: 1 },
      { op: "shells" },
      call("terminal:list", { chatId: "link:abc#2" }),
    ],
  },
  {
    name: "a Terminal running a command is busy and titled after it",
    options: { shell: { file: "/bin/sh", args: [] } },
    ops: [
      call("terminal:open", { chatId: "/p#1" }),
      ...["npm", "bash", "-zsh", "fish", "vim", "/usr/bin/python3", "", "-", "pwsh.exe", "CMD.EXE"].flatMap((name) => [
        { op: "process", pty: 0, name },
        call("terminal:list", { chatId: "/p#1" }),
      ]),
    ],
  },
  {
    name: "where node-pty names only the terminal type, the title is the shell and it is busy",
    options: { shell: { file: powershell, args: [] } },
    ops: [
      call("terminal:open", { chatId: "/p#1" }),
      { op: "process", pty: 0, name: "xterm-256color" },
      call("terminal:list", { chatId: "/p#1" }),
      { op: "state", pty: 0 },
    ],
  },
  {
    name: "a Chat's Terminals are limited, and so are all of them",
    options: { maxPerChat: 1, maxTotal: 2 },
    ops: [
      call("terminal:open", { chatId: "/p#1" }),
      call("terminal:open", { chatId: "/p#1" }),
      call("terminal:open", { chatId: "link:abc#2" }),
      call("terminal:open", { chatId: "link:abc#3" }),
    ],
  },
  {
    name: "a shell choice persists and only applies to new Terminals",
    options: {
      settings: true,
      availableShells: [
        { file: "/bin/bash", label: "bash" },
        { file: "/bin/zsh", label: "zsh" },
        { file: "/opt/bin/elvish", label: "elvish" },
        { file: "C:\\Tools\\pwsh.exe", label: "pwsh" },
      ],
    },
    ops: [
      call("terminal:profiles", undefined),
      call("terminal:open", { chatId: "/p#1" }),
      call("terminal:setShell", { shell: "/bin/bash" }),
      { op: "settings" },
      call("terminal:open", { chatId: "/p#1" }),
      call("terminal:setShell", { shell: "/opt/bin/elvish" }),
      call("terminal:open", { chatId: "/p#1" }),
      call("terminal:setShell", { shell: "C:\\Tools\\pwsh.exe" }),
      call("terminal:open", { chatId: "/p#1" }),
      ...[0, 1, 2, 3].map((pty) => ({ op: "state", pty })),
      { op: "restart" },
      call("terminal:profiles", undefined),
      call("terminal:setShell", { shell: null }),
      { op: "settings" },
      call("terminal:profiles", undefined),
      call("terminal:setShell", { shell: "/tmp/arbitrary-command" }),
      call("terminal:setShell", { shell: "bash" }),
      call("terminal:setShell", { shell: 5 }),
      call("terminal:setShell", {}),
    ],
  },
  {
    name: "a removed shell falls back to automatic selection",
    options: { availableShells: [{ file: "/bin/bash", label: "bash" }] },
    ops: [
      call("terminal:setShell", { shell: "/bin/bash" }),
      { op: "removeShells" },
      call("terminal:profiles", undefined),
      call("terminal:open", { chatId: "/p#1" }),
      { op: "state", pty: 0 },
    ],
  },
  {
    name: "a disposed owner answers reads as ended and refuses the rest",
    ops: [
      call("terminal:open", { chatId: "/p#1" }),
      { op: "dispose" },
      { op: "state", pty: 0 },
      call("terminal:list", { chatId: "/p#1" }),
      call("terminal:read", { terminalId: "$T0", after: 0 }),
      call("terminal:input", { terminalId: "$T0", data: "x" }),
      call("terminal:input", { terminalId: "$T0", data: 5 }),
      call("terminal:resize", { terminalId: "$T0", cols: 10, rows: 10 }),
      call("terminal:close", { terminalId: "$T0" }),
      call("terminal:open", { chatId: "/p#1" }),
      call("terminal:profiles", undefined),
      call("terminal:setShell", { shell: null }),
      call("terminal:setShell", { shell: 5 }),
      { op: "shells" },
    ],
  },
];

function fakePty(file, args, options) {
  const data = new Set(),
    exits = new Set();
  const pty = {
    file,
    args,
    options,
    pid: 4242,
    process: path.basename(file),
    written: [],
    sizes: [],
    killed: false,
    onData: (listener) => data.add(listener),
    onExit: (listener) => exits.add(listener),
    write: (text) => pty.written.push(text),
    resize: (cols, rows) => pty.sizes.push([cols, rows]),
    kill: () => {
      pty.killed = true;
    },
  };
  pty.emit = (text) => data.forEach((listener) => listener(text));
  pty.exit = () => exits.forEach((listener) => listener({ exitCode: 0 }));
  return pty;
}

async function runScenario(scenario) {
  const options = scenario.options ?? {};
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-terminal-conformance-"));
  const folders = { $FIRST: path.join(base, "first"), $SECOND: path.join(base, "second"), $OUTSIDE: path.join(base, "outside") };
  for (const folder of Object.values(folders)) fs.mkdirSync(folder);
  const settingsFile = options.settings ? path.join(base, "data", "terminal-settings.json") : undefined;
  const chats = {
    "/p#1": [{ path: folders.$FIRST, label: "one" }],
    "link:abc#2": [
      { path: folders.$FIRST, label: "api" },
      { path: folders.$SECOND, label: "web" },
    ],
    "link:abc#3": [{ path: folders.$SECOND }],
    "/p#empty": [],
    "/p#gone": [{ path: path.join(base, "missing"), label: "gone" }],
  };
  let available = options.availableShells ?? [{ file: "/bin/zsh", label: "zsh" }];
  const ptys = [];
  const events = [];
  const ids = [];
  const make = () =>
    createTerminals({
      resolveChat: async (chatId) => {
        if (!chats[chatId]) throw new Error("This Chat is archived.");
        return chats[chatId];
      },
      spawn: (file, args, spawnOptions) => {
        const pty = fakePty(file, args, spawnOptions);
        ptys.push(pty);
        return pty;
      },
      shell: () => options.shell ?? zshShell,
      availableShells: () => available,
      environment: () => ({ TERM: "xterm-256color", PATH: "/usr/bin:/bin" }),
      settingsFile,
      onChange: (chatId) => events.push(["changed", chatId]),
      onShellsChanged: () => events.push(["shells"]),
      onPreferencesChanged: () => events.push(["preferences"]),
      maxBufferChars: options.maxBufferChars,
      maxBufferLines: options.maxBufferLines,
      maxPerChat: options.maxPerChat,
      maxTotal: options.maxTotal,
      readWaitMs: 20,
      titlePollMs: 3_600_000,
      now: () => 1000,
    });
  let terminals = make();
  const tokenize = (value) => {
    let text = JSON.stringify(value === undefined ? null : value);
    ids.forEach((id, index) => (text = text.split(id).join(`$T${index}`)));
    for (const [token, folder] of Object.entries(folders)) text = text.split(JSON.stringify(folder).slice(1, -1)).join(token);
    text = text.split(JSON.stringify(base).slice(1, -1)).join("$BASE");
    return JSON.parse(text);
  };
  const untokenize = (value) => {
    if (value === undefined) return undefined;
    let text = JSON.stringify(value);
    ids.forEach((id, index) => (text = text.split(`"$T${index}"`).join(JSON.stringify(id))));
    for (const [token, folder] of Object.entries(folders)) text = text.split(token).join(JSON.stringify(folder).slice(1, -1));
    return JSON.parse(text);
  };
  const results = [];
  try {
    for (const op of scenario.ops) {
      events.length = 0;
      let result;
      if (op.op === "call") {
        const method = op.command.slice("terminal:".length);
        try {
          const value = await terminals[method](untokenize(op.request));
          if (method === "open" && value?.id) ids.push(value.id);
          result = { ok: tokenize(value) };
        } catch (error) {
          result = { error: tokenize(error.message) };
        }
      } else if (op.op === "emit") ptys[op.pty].emit(op.text);
      else if (op.op === "exit") ptys[op.pty].exit();
      else if (op.op === "process") ptys[op.pty].process = op.name;
      else if (op.op === "closeChat") terminals.closeChat(op.chat);
      else if (op.op === "shells") result = { ok: [...terminals.shells()].map(([chatId, pids]) => [chatId, pids]) };
      else if (op.op === "dispose") await terminals.dispose();
      else if (op.op === "removeShells") available = [];
      else if (op.op === "restart") {
        await terminals.dispose();
        terminals = make();
      } else if (op.op === "settings") result = { ok: JSON.parse(fs.readFileSync(settingsFile, "utf8")) };
      else if (op.op === "state") {
        const pty = ptys[op.pty];
        result = {
          ok: tokenize({
            file: pty.file,
            args: pty.args,
            cwd: pty.options.cwd,
            cols: pty.options.cols,
            rows: pty.options.rows,
            name: pty.options.name,
            env: pty.options.env,
            written: pty.written,
            sizes: pty.sizes,
            killed: pty.killed,
          }),
        };
      } else throw new Error(`Unknown op ${op.op}`);
      results.push({ result: result ?? null, events: tokenize(events) });
    }
  } finally {
    await terminals.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  }
  return { name: scenario.name, options: scenario.options ?? {}, ops: scenario.ops, results };
}

// ---- Shell discovery and environment -------------------------------------------------------------------------------

const shellCases = [
  { platform: "darwin", env: { SHELL: "/bin/zsh" }, exists: ["/opt/homebrew/bin/fish", "/bin/zsh"], userShell: "/opt/homebrew/bin/fish" },
  { platform: "darwin", env: { SHELL: "/opt/homebrew/bin/fish" }, exists: ["/opt/homebrew/bin/fish", "/bin/zsh"], userShell: null },
  { platform: "darwin", env: { SHELL: "/tmp/evil" }, exists: ["/tmp/evil", "/bin/zsh"], userShell: "/tmp/missing" },
  { platform: "darwin", env: {}, exists: [], userShell: { throw: true } },
  { platform: "darwin", env: { SHELL: "bash" }, exists: ["bash"], userShell: "relative/zsh" },
  { platform: "freebsd", env: {}, exists: ["/bin/sh"], userShell: null },
  { platform: "win32", env: { Path: "C:\\Tools", SystemRoot: "C:\\Windows" }, exists: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"] },
  {
    platform: "win32",
    env: { PATH: "C:\\Tools;D:\\bin", ProgramFiles: "C:\\Program Files" },
    exists: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "D:\\bin\\pwsh.exe"],
  },
  { platform: "win32", env: { Path: "", PATH: "C:\\Tools", ComSpec: "C:\\Custom\\cmd.exe" }, exists: [] },
  { platform: "win32", env: {}, exists: [] },
  ...["/usr/bin/zsh", "/bin/zsh", "/usr/local/bin/zsh", "/opt/shells/zsh"].map((location) => ({
    platform: "linux",
    env: { SHELL: "/bin/bash", PATH: "/opt/shells:/usr/bin:/bin" },
    userShell: "/bin/bash",
    exists: ["/bin/bash", location],
  })),
  {
    platform: "linux",
    env: { SHELL: "/opt/environment/zsh" },
    userShell: "/opt/account/zsh",
    exists: ["/opt/account/zsh", "/opt/environment/zsh", "/usr/bin/zsh", "/bin/bash"],
  },
  {
    platform: "linux",
    env: { SHELL: "/opt/environment/zsh" },
    userShell: "/bin/bash",
    exists: ["/opt/account/zsh", "/opt/environment/zsh", "/usr/bin/zsh", "/bin/bash"],
  },
  { platform: "linux", env: { SHELL: "/usr/bin/fish" }, userShell: "/bin/bash", exists: ["/bin/bash", "/usr/bin/fish", "/bin/sh"] },
  { platform: "linux", env: { SHELL: "/usr/bin/fish" }, userShell: { throw: true }, exists: ["/bin/bash", "/usr/bin/fish", "/bin/sh"] },
  { platform: "linux", env: { SHELL: "/missing/zsh", PATH: ".:relative" }, userShell: null, exists: ["/bin/bash", "/usr/bin/fish", "/bin/sh"] },
  { platform: "linux", env: { PATH: "/opt/bin/:/usr/bin/.:/a/b/../c" }, userShell: null, exists: ["/opt/bin/zsh", "/a/c/fish", "/usr/bin/bash"] },
  {
    platform: "linux",
    env: { PATH: "/opt/bin:/usr/bin:.", SHELL: "/bin/bash" },
    userShell: "/bin/bash",
    exists: ["/bin/bash", "/usr/bin/bash", "/opt/bin/fish", "/usr/bin/zsh", "/opt/custom/shell"],
    readShells: "# Login shells\n/bin/bash\r\n/usr/bin/bash\n/opt/custom/shell # installed\n/missing/sh\n\n",
    realpath: { "/bin/bash": "/usr/bin/bash" },
  },
  { platform: "linux", env: { PATH: "/opt/bin" }, userShell: null, exists: ["/opt/bin/fish"], readShells: { throw: true } },
  {
    platform: "darwin",
    env: { PATH: "/opt/homebrew/bin:/usr/bin" },
    userShell: "/bin/zsh",
    exists: ["/bin/zsh", "/bin/bash", "/bin/sh", "/usr/bin/zsh", "/opt/homebrew/bin/fish", "/opt/homebrew/bin/nu"],
    readShells: "/bin/zsh\n/bin/bash\n/bin/sh\n",
    realpath: { "/usr/bin/zsh": "/bin/zsh" },
  },
  {
    platform: "win32",
    env: { Path: "C:\\Tools;C:\\Windows\\System32" },
    exists: ["C:\\Tools\\pwsh.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "C:\\Windows\\System32\\cmd.exe"],
    realpath: { "C:\\Windows\\System32\\cmd.exe": "C:\\WINDOWS\\System32\\CMD.EXE" },
  },
  {
    platform: "win32",
    env: { Path: "C:\\Tools" },
    exists: ["C:\\Tools\\pwsh.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "C:\\Windows\\System32\\cmd.exe"],
  },
];

function probe(item) {
  const files = new Set(item.exists);
  return {
    platform: item.platform,
    env: item.env,
    exists: (file) => files.has(file),
    userShell: () => {
      if (item.userShell && typeof item.userShell === "object") throw new Error("No account");
      return item.userShell ?? null;
    },
    readShells: () => {
      if (item.readShells && typeof item.readShells === "object") throw new Error("Missing");
      return item.readShells ?? "";
    },
    realpath: (file) => item.realpath?.[file] ?? file,
  };
}

const environmentCases = [
  { ELECTRON_RUN_AS_NODE: "1", MILAGRE_BUNDLED_BIN_DIR: "/x", PATH: "/bin", LANG: "pt_BR.UTF-8" },
  { PATH: "/bin", LANG: "", TERM: "dumb", PWD: "/p", OLDPWD: "/o", SHLVL: "3", _: "/usr/bin/node", ELECTRON_NO_ATTACH_CONSOLE: "1", HOME: "/home/x" },
  {},
];

// ---- UTF-8 decoding as node-pty's setEncoding("utf8") ---------------------------------------------------------------

const decoderCases = [
  [[...Buffer.from("ação 😀 中文")].map((byte) => [byte])].flat(),
  [[0xe2, 0x82, 0x41, 0xff], [0xf0, 0x9f], [0x98, 0x80], [0xc3]],
  [
    [0xed, 0xa0, 0x80, 0x41],
    [0xf4, 0x90, 0x80, 0x80],
    [0xc0, 0xaf],
    [0xe0, 0x80],
  ],
  [[0xf0, 0x9f, 0x98], [0x41]],
  [[0xe4], [0xb8], [0xad, 0x0a]],
  [[0xe0, 0x80]],
  [[0xe0, 0x80], [0x80]],
  [[0xe0, 0x80], [0x41]],
  [
    [0xf0, 0x9f],
    [0x41, 0x42],
  ],
  [[0xf0], [0x9f, 0x98], [0x80, 0x41]],
  [[0x80, 0x80, 0x80]],
  [[0x41, 0x80, 0x80, 0x80]],
  [[0xc3, 0x80, 0x80]],
  [[0xff, 0xc3]],
  [[0xf8, 0x80]],
  [
    [0xe2, 0x82],
    [0xac, 0xe2],
    [0x82, 0xac],
  ],
  [[0xc3], [0xc3], [0xa9]],
  [[0xf0, 0x9f, 0x98]],
  [[0xf0, 0x9f, 0x98, 0x80, 0x80, 0x80, 0x80, 0x80], [0x80]],
  [[0xe2], [], [0x82], [0xac]],
];

// Long strings (thousands of repeated characters) are written as { "$runs": [[text, count], ...] } so the fixture
// stays small; the Rust test expands them. Runs split by code point, so astral characters stay whole.
function compact(value) {
  if (typeof value === "string" && value.length > 200) {
    const runs = [];
    for (const char of value) {
      const last = runs.at(-1);
      if (last && last[0] === char) last[1]++;
      else runs.push([char, 1]);
    }
    const merged = [];
    for (const [char, count] of runs) {
      const last = merged.at(-1);
      if (count === 1 && last && last[1] === 1) last[0] += char;
      else merged.push([char, count]);
    }
    return { $runs: merged };
  }
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item)]));
  return value;
}

// Terminal read waits use unref'd timers; keep the process alive until the fixture is written.
const keepAlive = setInterval(() => {}, 1000);
(async () => {
  const owner = [];
  for (const scenario of scenarios) owner.push(await runScenario(scenario));
  const fixture = {
    generatedBy: "experiments/rust-terminals/scripts/generate-conformance.cjs",
    source: "packages/core/src/terminals.cjs",
    hostPlatform: process.platform,
    owner,
    shells: shellCases.map((item) => ({ input: item, shell: terminalShell(probe(item)), shells: terminalShells(probe(item)) })),
    environment: environmentCases.map((env) => ({ input: env, output: terminalEnvironment(env) })),
    decoder: decoderCases.map((chunks) => {
      const decoder = new StringDecoder("utf8");
      return { chunks, outputs: chunks.map((chunk) => decoder.write(Buffer.from(chunk))), end: decoder.end() };
    }),
  };
  fs.writeFileSync(output, JSON.stringify(compact(fixture), null, 1) + "\n");
  clearInterval(keepAlive);
  console.log(`Wrote ${path.relative(root, output)}: ${owner.length} owner scenarios, ${shellCases.length} shell cases.`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

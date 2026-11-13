#!/usr/bin/env node
// Regenerates tests/fixtures/conformance.json from the Node port watcher (packages/core/src/agents/ports.cjs), so
// the Rust port reads the same listings, assigns the same owners and runs the same commands. Run from the repo root:
//   node experiments/rust-ports/scripts/generate-conformance.cjs
//   npx oxfmt experiments/rust-ports/tests/fixtures/conformance.json
// Nothing is run or signalled: every PortWatcher gets a scripted exec, kill and Windows tree stop, and the Windows
// commands are captured by replacing child_process.execFile before ports.cjs loads.
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const captured = [];
let capturedStdout = "";
childProcess.execFile = (file, args, options, callback) => {
  captured.push({ file, args, psModulePath: options?.env?.PSModulePath ?? null, maxBuffer: options?.maxBuffer, timeout: options?.timeout });
  setImmediate(() => callback(null, capturedStdout, ""));
};

const root = path.resolve(__dirname, "../../..");
const { PortWatcher, chatPorts, chatProcesses, parseLsof, parsePs, parseTaskOutputs } = require(path.join(root, "packages/core/src/agents/ports.cjs"));
const output = path.join(__dirname, "../tests/fixtures/conformance.json");

// ---- Listings ------------------------------------------------------------------------------------------------------

// macOS: the agent (100) leads group 100 with its MCP server (101); its command shells lead their own groups.
const PS = `
    1     0     1 /sbin/launchd
  100    50   100 /Users/me/.local/bin/claude
  101   100   100 node
  110   100   110 /bin/zsh
  111   110   110 node
  112   111   110 esbuild
  200    50   200 /Applications/Codex.app/codex
  210   200   210 /usr/bin/sandbox-exec
  211   210   210 python3
`;
// Linux procps: comm is the 15-character task name.
const LINUX_PS =
  "    1     0     1 systemd\n 4100  4000  4100 claude\n 4110  4100  4110 bash\n 4111  4110  4110 node\n 4112  4111  4110 vite\n 4113  4100  4100 node-mcp-server\n";
// Windows: the PowerShell script prints pid ppid pid @ticks name.
const WINDOWS_PS =
  "4 0 4 @638000000000000000 System\r\n900 700 900 @638500000000000001 claude.exe\r\n910 900 910 @638500000000000002 pwsh.exe\r\n911 910 911 @638500000000000003 node.exe\r\n912 911 912 @638500000000000004 node.exe\r\n";
const LSOF = [
  "p101",
  "cnode",
  "f20",
  "n127.0.0.1:4545",
  "p111",
  "cnode",
  "f21",
  "n*:5173",
  "f22",
  "n[::1]:5173",
  "f23",
  "n127.0.0.1:24678",
  "p211",
  "cPython",
  "f3",
  "n*:8000",
  "",
].join("\n");
const LINUX_LSOF = ["p4112", "cnode", "f21", "n*:5173", "f22", "n[::]:5173", "p4113", "cnode", "n127.0.0.1:7777", ""].join("\n");
const WINDOWS_LSOF = ["p912", "cnode", "n0.0.0.0:3000", "p912", "cnode", "n:::3000", "p911", "cnode", "n127.0.0.1:9229", ""].join("\r\n");

const psCases = [
  PS,
  LINUX_PS,
  WINDOWS_PS,
  "  12 1 12\n  13 1 13 \n x 1 1 sh\n 14 1 14 a  b \n15\t1\t15\tzsh\n16 1 16 @12 \n17 1 17 @12x y\n18 1 18 @ y\n19 1 19 -zsh\n20 1 20 /Applications/My App.app/Contents/MacOS/My App\n",
  "",
];
const lsofCases = [
  LSOF,
  LINUX_LSOF,
  WINDOWS_LSOF,
  "n*:1\np0\nn*:2\npabc\nn*:3\np7\nn*:x\nnlocalhost\nn[fe80::1%lo0]:631\nn*:80\nn*:80\nc\nn1.2.3.4:443\np8\ncnext\nn*:80\n",
];
const taskCases = [
  "p110\nf1\nn/private/tmp/claude-501/-repo/abc/tasks/bk1x2y3z4.output\np111\nf1\nnpipe\n",
  "p7\nn/Users/me/log.txt\np8\nnC:\\Temp\\tasks\\b9.output\n",
  "n/x/tasks/early.output\np9\nn/x/tasks/a.b.output\nn/x/mytasks/no.output\nn/x/tasks/ok_1-2.output\np10\nn/x/tasks/first.output\nn/x/tasks/second.output\n",
];

// ---- Ownership -----------------------------------------------------------------------------------------------------

const sequences = [
  {
    name: "command shells and execution agents, not MCP servers",
    steps: [
      { ps: PS, roots: { "/a#1": { pid: 100 }, "/b#2": { pid: 200 } }, lsof: LSOF },
      {
        ps: "  10 1 10 codex\n  11 10 11 zsh\n  20 1 20 claude\n  21 20 21 zsh\n  22 21 21 node\n  30 1 30 node\n",
        roots: { parent: { pid: 10, agents: [20] } },
        lsof: "p22\ncnode\nn127.0.0.1:5180\np30\ncnode\nn127.0.0.1:6000\n",
      },
    ],
  },
  {
    name: "Terminal shells are roots, with or without an agent",
    steps: [
      {
        ps: `${PS}  300    50   300 /opt/homebrew/bin/fish\n  301   300   301 node\n`,
        roots: { "/a#1": { pid: 100, shells: [300] }, "/c#3": { shells: [300] } },
        lsof: "p301\ncnode\nn*:3000\n",
      },
    ],
  },
  {
    name: "an orphaned server stays with its Chat until its group is empty",
    steps: [
      { ps: PS, roots: { "/a#1": { pid: 100 } }, lsof: LSOF },
      { ps: "    1     0     1 /sbin/launchd\n  111     1   110 node\n", roots: {}, lsof: LSOF },
      { ps: "    1     0     1 /sbin/launchd\n  111     1   110 node\n  120     1   110 worker\n", roots: { "/a#1": { pid: 100 } }, lsof: LSOF },
      { ps: "    1     0     1 /sbin/launchd\n", roots: {}, lsof: LSOF },
    ],
  },
  {
    name: "Chats sharing a Worktree never take each other's orphans",
    steps: [
      { ps: PS, roots: { "/repo#1": { pid: 100, cwd: "/repo" }, "/repo#2": { pid: 200, cwd: "/repo" } }, lsof: `${LSOF}p300\ncnode\nn*:9000\n` },
      {
        ps: PS.replace(/^.*\b11[012]\b.*$/gm, "") + "111 1 110 node\n300 1 299 node\n",
        roots: { "/repo#1": { pid: 100, cwd: "/repo" }, "/repo#2": { pid: 200, cwd: "/repo" } },
        lsof: `${LSOF}p300\ncnode\nn*:9000\n`,
      },
    ],
  },
  {
    name: "a login shell and a missing agent",
    steps: [
      {
        ps: "  50 1 50 claude\n  51 50 50 -zsh\n  52 51 50 node\n  53 50 50 node\n",
        roots: { "/l#1": { pid: 50 }, "/gone#2": { pid: 999, shells: [998] } },
        lsof: "p52\ncnode\nn*:4000\np53\ncnode\nn*:4001\n",
      },
    ],
  },
  {
    name: "Linux and Windows listings",
    steps: [
      { ps: LINUX_PS, roots: { "/linux#1": { pid: 4100 } }, lsof: LINUX_LSOF },
      { ps: WINDOWS_PS, roots: { "/win#1": { pid: 900 } }, lsof: WINDOWS_LSOF },
    ],
  },
  {
    name: "tasks are found through the listener or its group leader",
    steps: [{ ps: PS, roots: { "/a#1": { pid: 100 } }, lsof: LSOF, tasks: "p110\nn/t/tasks/lead.output\np211\nn/t/tasks/own.output\n" }],
  },
];

const sorted = (values) => [...values].sort((a, b) => a - b);
const plainGroups = (groups) => Object.fromEntries([...groups].map(([chat, set]) => [chat, sorted(set)]).sort(([a], [b]) => (a < b ? -1 : 1)));
const rootsMap = (roots) => new Map(Object.entries(roots));

function runSequence(sequence) {
  const groups = new Map();
  return {
    name: sequence.name,
    steps: sequence.steps,
    results: sequence.steps.map((step) => {
      const processes = parsePs(step.ps);
      const byChat = chatProcesses(processes, rootsMap(step.roots), groups);
      const byPid = new Map(processes.map((row) => [row.pid, row]));
      const tasks = parseTaskOutputs(step.tasks ?? "");
      const ports = chatPorts(parseLsof(step.lsof), byChat, (pid) => tasks.get(pid) ?? tasks.get(byPid.get(pid)?.pgid));
      return { byChat: Object.fromEntries([...byChat].map(([chat, pids]) => [chat, sorted(pids)])), groups: plainGroups(groups), ports };
    }),
  };
}

// ---- The watcher ---------------------------------------------------------------------------------------------------

const WIN_GONE = "4 0 4 @638000000000000000 System\r\n900 700 900 @638500000000000001 claude.exe\r\n910 900 910 @638500000000000002 pwsh.exe\r\n";
const watcherScenarios = [
  {
    name: "publishes changes once and stops when nothing runs",
    steps: [
      { set: { ps: PS, lsof: LSOF, roots: { "/a#1": { pid: 100 } } } },
      { poll: false },
      { poll: false },
      { set: { roots: {}, ps: "    1     0     1 /sbin/launchd\n" } },
      { poll: false },
      { poll: false },
    ],
  },
  {
    name: "lsof runs when pids change or the cache is old",
    options: { lsofMaxAgeMs: 10_000 },
    steps: [
      { set: { ps: PS, lsof: LSOF, roots: { "/a#1": { pid: 100 } }, now: 0 } },
      { poll: false },
      { set: { now: 3000 } },
      { poll: false },
      { set: { now: 9999 } },
      { poll: false },
      { set: { now: 10_000 } },
      { poll: false },
      { set: { now: 11_000, ps: PS + "  113   110   110 node\n" } },
      { poll: false },
      { set: { now: 11_500 } },
      { poll: true },
    ],
  },
  {
    name: "a Chat with no processes runs no lsof",
    steps: [{ set: { ps: "  100  50  100 claude\n", lsof: LSOF, roots: { "/z#1": { pid: 100 } } } }, { poll: false }],
  },
  {
    name: "stopping a port stops its command's group, and only a listed pid",
    steps: [
      { set: { ps: PS, lsof: LSOF, roots: { "/a#1": { pid: 100 } }, afterKill: { ps: PS.replace(/^.*\b11[012]\b.*$/gm, ""), lsof: "" } } },
      { poll: false },
      { stop: ["/a#1", 101] },
      { stop: ["/b#2", 111] },
      { stop: ["/a#1", 112] },
      { stop: ["/a#1", 111] },
      { stop: ["/a#1", 111] },
    ],
  },
  {
    name: "a port that ignores SIGTERM gets SIGKILL",
    steps: [{ set: { ps: PS, lsof: LSOF, roots: { "/a#1": { pid: 100 } }, termKills: false } }, { poll: false }, { stop: ["/a#1", 111] }],
  },
  {
    name: "a SIGTERM that fails stops nothing",
    steps: [{ set: { ps: PS, lsof: LSOF, roots: { "/a#1": { pid: 100 } }, termFails: true } }, { poll: false }, { stop: ["/a#1", 111] }],
  },
  {
    name: "a Terminal's port in the shell's own group stops the process alone",
    steps: [
      {
        set: {
          ps: "    1     0     1 /sbin/launchd\n  300    50   300 /bin/zsh\n  301   300   300 node\n  302   300   302 vite\n",
          lsof: "p301\ncnode\nn*:3000\np302\ncvite\nn*:5173\n",
          roots: { "/c#3": { shells: [300] } },
        },
      },
      { poll: false },
      { stop: ["/c#3", 301] },
      { set: { alive: true } },
      { stop: ["/c#3", 302] },
    ],
  },
  {
    name: "an orphan of a shared Worktree is nobody's to stop",
    steps: [
      { set: { ps: PS, lsof: `${LSOF}p300\ncnode\nn*:9000\n`, roots: { "/repo#1": { pid: 100, cwd: "/repo" }, "/repo#2": { pid: 200, cwd: "/repo" } } } },
      { poll: false },
      { set: { ps: PS.replace(/^.*\b11[012]\b.*$/gm, "") + "111 1 110 node\n300 1 299 node\n" } },
      { poll: true },
      { stop: ["/repo#2", 111] },
      { stop: ["/repo#2", 300] },
    ],
  },
  {
    name: "a background task names its ports",
    steps: [
      {
        set: {
          ps: PS,
          lsof: LSOF,
          tasks: "p110\nf1\nn/private/tmp/claude-501/-repo/abc/tasks/bk1x2y3z4.output\np111\nf1\nnpipe\n",
          roots: { "/a#1": { pid: 100 } },
        },
      },
      { poll: false },
    ],
  },
  {
    name: "a closed watcher neither publishes nor polls",
    steps: [{ set: { ps: PS, lsof: LSOF, roots: { "/a#1": { pid: 100 } } } }, { close: true }, { poll: false }, { stop: ["/a#1", 111] }],
  },
  {
    name: "Windows: identities, tree stops by start time, nothing for task outputs",
    options: { windows: true },
    steps: [
      { set: { ps: WINDOWS_PS, lsof: WINDOWS_LSOF, roots: { "/win#1": { pid: 900 } }, afterKill: { ps: WIN_GONE, lsof: "" } } },
      { poll: false },
      { stop: ["/win#1", 912] },
      { stop: ["/win#1", 912] },
    ],
  },
  {
    name: "Windows: a reused pid is no longer the Chat's",
    options: { windows: true },
    steps: [
      { set: { ps: WINDOWS_PS, lsof: WINDOWS_LSOF, roots: { "/win#1": { pid: 900 } } } },
      { poll: false },
      { set: { ps: WINDOWS_PS.replace("@638500000000000004 node.exe", "@639999999999999999 node.exe"), roots: {} } },
      { poll: true },
      { stop: ["/win#1", 912] },
      { set: { roots: { "/win#1": { pid: 901 } } } },
      { poll: true },
    ],
  },
];

async function runWatcher(scenario) {
  const options = scenario.options ?? {};
  const state = { ps: "", lsof: "", tasks: "", roots: {}, now: 0, alive: true, termKills: true, termFails: false, afterKill: null };
  let calls = [],
    kills = [],
    trees = [],
    published = [];
  const die = () => {
    state.alive = false;
    if (state.afterKill) Object.assign(state, state.afterKill);
  };
  const watcher = new PortWatcher({
    platform: options.windows ? "win32" : "darwin",
    roots: () => rootsMap(state.roots),
    publish: (ports) => published.push(ports),
    pollMs: 3_600_000,
    idlePollMs: 3_600_000,
    graceMs: 0,
    now: () => state.now,
    lsofMaxAgeMs: options.lsofMaxAgeMs ?? 10_000,
    exec: async (command, args) => {
      calls.push([command, args]);
      if (command === "ps") return state.ps;
      return args.includes("-d") ? state.tasks : state.lsof;
    },
    kill: (target, signal) => {
      kills.push([target, signal]);
      if (signal === "SIGTERM") {
        if (state.termFails) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        if (state.termKills) die();
      }
      if (signal === "SIGKILL") die();
      if (signal === 0 && !state.alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    stopWindowsTree: async (pid, _unused, { expectedStartTime }) => {
      trees.push([pid, expectedStartTime]);
      die();
    },
  });
  const results = [];
  for (const step of scenario.steps) {
    calls = [];
    kills = [];
    trees = [];
    published = [];
    let result = null;
    if (step.set) Object.assign(state, step.set);
    if (step.poll !== undefined) await watcher.poll({ fresh: step.poll });
    if (step.stop) result = await watcher.stopPort(...step.stop);
    if (step.close) watcher.close();
    results.push({ calls, kills, trees, published, snapshot: watcher.snapshot(), groups: plainGroups(watcher.groups), result });
  }
  watcher.close();
  return { name: scenario.name, options, steps: scenario.steps, results };
}

// ---- Windows commands, as run() starts them ------------------------------------------------------------------------

async function windowsCommands() {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const systemRoot = process.env.SystemRoot;
  const cases = [
    { systemRoot: null, command: "ps", args: ["-axo", "pid=,ppid=,pgid=,comm="] },
    { systemRoot: "D:\\Win", command: "lsof", args: ["-nP", "-a", "-p", "910,911,912", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"] },
    { systemRoot: null, command: "lsof", args: ["-nP", "-a", "-p", "1;Remove-Item x", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"] },
    { systemRoot: null, command: "lsof", args: ["-nP", "-a", "-p", "911", "-d", "1", "-F", "pn"] },
    { systemRoot: null, command: "whoami", args: [] },
  ];
  const results = [];
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    for (const item of cases) {
      if (item.systemRoot) process.env.SystemRoot = item.systemRoot;
      else delete process.env.SystemRoot;
      captured.length = 0;
      capturedStdout = "p1\ncx\nn*:1\n";
      const watcher = new PortWatcher({ roots: () => new Map(), publish() {} });
      const stdout = await watcher.exec(item.command, item.args);
      results.push({ ...item, stdout, started: captured.slice() });
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  }
  return results;
}

(async () => {
  const watchers = [];
  for (const scenario of watcherScenarios) watchers.push(await runWatcher(scenario));
  const fixture = {
    generatedBy: "experiments/rust-ports/scripts/generate-conformance.cjs",
    source: "packages/core/src/agents/ports.cjs",
    ps: psCases.map((input) => ({ input, rows: parsePs(input) })),
    lsof: lsofCases.map((input) => ({ input, rows: parseLsof(input) })),
    tasks: taskCases.map((input) => ({ input, tasks: Object.fromEntries(parseTaskOutputs(input)) })),
    ownership: sequences.map(runSequence),
    watcher: watchers,
    windowsCommands: await windowsCommands(),
  };
  fs.writeFileSync(output, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`Wrote ${path.relative(root, output)}: ${sequences.length} ownership sequences, ${watchers.length} watcher scenarios.`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

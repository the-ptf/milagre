const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DISK_RETRY, availableMemory, createComputerResources, milagreFolders, parseDu, parseProcesses, run, treeMemory } = require("./computer-resources.cjs");

const APP = "/Applications/Milagre.app/Contents/MacOS/Milagre";
const PS = [
  "    1     0   100 /sbin/launchd",
  `  100     1  2000 ${APP}`,
  "  101   100  3000 /Applications/Milagre.app/Contents/Frameworks/Milagre Helper (Renderer).app/Contents/MacOS/Milagre Helper (Renderer) --type=renderer",
  `  102   100  4000 ${APP} /Applications/Milagre.app/Contents/Resources/app.asar/daemon/cli.cjs serve`,
  "  103   102  5000 /Users/me/.local/bin/claude --output-format stream-json",
  "  104   103   600 /bin/zsh -c ls",
  "  105   102   700 /Users/me/.local/bin/claude",
  "  106   102   800 /opt/homebrew/bin/codex app-server",
  "  107   106   300 /opt/homebrew/bin/codex-code-mode-host",
  "  108   102   400 -zsh",
  "  109   102   200 /Users/me/.milagre/antigravity/agy_acp_server.par",
  "  200     1  9000 /Applications/Safari.app/Contents/MacOS/Safari",
].join("\n");
const ALL = (2000 + 3000 + 4000 + 5000 + 600 + 700 + 800 + 300 + 400 + 200) * 1024;

test("Milagre's memory is the app's whole tree when the daemon runs inside it, else the daemon's own", () => {
  const processes = parseProcesses(PS);
  assert.equal(processes[2].args.endsWith("Milagre Helper (Renderer) --type=renderer"), true, "command lines keep their spaces");
  assert.equal(treeMemory(processes, { pid: 102, execPath: APP }).total, ALL);
  // A daemon started from a shell, like mobile-host: only it and its agents.
  const shell = parseProcesses(
    "  1 0 1 /sbin/launchd\n  50 1 10 -zsh\n  51 50 20 /usr/local/bin/node scripts/mobile-host.cjs\n  52 51 30 /Users/me/.local/bin/claude",
  );
  assert.equal(treeMemory(shell, { pid: 51, execPath: "/usr/local/bin/node" }).total, 50 * 1024);
});

test("the parent comes from the snapshot, so a daemon that outlived its app counts the new app, not a stranger on the old pid", () => {
  // The first app (pid 100) quit; launchd adopted the daemon; a new app runs as 300; pid 100 now belongs to someone else.
  const orphaned = parseProcesses(
    [
      "    1     0   100 /sbin/launchd",
      "  100     1 90000 /usr/local/bin/node /tmp/unrelated.js",
      `  102     1  4000 ${APP} /Applications/Milagre.app/Contents/Resources/app.asar/daemon/cli.cjs serve`,
      "  103   102  5000 /Users/me/.local/bin/claude",
      `  300     1  2500 ${APP}`,
      "  301   300  3500 /Applications/Milagre.app/Contents/Frameworks/Milagre Helper (Renderer).app/Contents/MacOS/Milagre Helper (Renderer)",
    ].join("\n"),
  );
  const { total, parts } = treeMemory(orphaned, { pid: 102, execPath: APP });
  assert.equal(total, (4000 + 5000 + 2500 + 3500) * 1024, "the daemon, its agent and the new app; not pid 100");
  assert.deepEqual(parts, [
    { kind: "claude", bytes: 5000 * 1024, count: 1 },
    { kind: "app", bytes: (4000 + 2500 + 3500) * 1024, count: 0 },
  ]);
});

test("each agent's whole subtree is that agent's, a terminal's shell is a terminal, the rest is the app", () => {
  const { parts } = treeMemory(parseProcesses(PS), { pid: 102, execPath: APP });
  assert.deepEqual(parts, [
    // The zsh under a Claude agent is its Bash tool, not a terminal.
    { kind: "claude", bytes: (5000 + 600 + 700) * 1024, count: 2 },
    { kind: "codex", bytes: (800 + 300) * 1024, count: 1 },
    { kind: "antigravity", bytes: 200 * 1024, count: 1 },
    { kind: "terminals", bytes: 400 * 1024, count: 1 },
    { kind: "app", bytes: (2000 + 3000 + 4000) * 1024, count: 0 },
  ]);
});

test("an agent running under its interpreter is still that agent", () => {
  const interpreted = parseProcesses(
    [
      "  1 0 1 /sbin/launchd",
      `  10 1 100 ${APP}`,
      `  11 10 200 ${APP} daemon`,
      // Antigravity's .par runs as Python; ps's comm would say python3.
      "  12 11 900 /usr/bin/python3 /Users/me/.milagre/antigravity/1.3.0/agy_acp_server.par",
      "  13 12 50 /Users/me/.milagre/antigravity/1.3.0/localharness_external",
      // An npm Claude Code runs as node; its Bash tool's shell is still Claude's.
      "  14 11 400 /usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      "  15 14 30 /bin/zsh -c git status",
    ].join("\n"),
  );
  assert.deepEqual(treeMemory(interpreted, { pid: 11, execPath: APP }).parts, [
    { kind: "claude", bytes: (400 + 30) * 1024, count: 1 },
    { kind: "antigravity", bytes: (900 + 50) * 1024, count: 1 },
    { kind: "app", bytes: (100 + 200) * 1024, count: 0 },
  ]);
});

test("free memory comes from the kernel's level on a Mac and MemAvailable on Linux, never a failed read's zero", async () => {
  const exec = async (file, args) => {
    assert.deepEqual([file, ...args], ["sysctl", "-n", "kern.memorystatus_level"]);
    return "54\n";
  };
  assert.equal(await availableMemory(1000, { platform: "darwin", exec }), 540);
  const failing = async () => {
    throw new Error("sysctl not allowed");
  };
  const failed = await availableMemory(1000, { platform: "darwin", exec: failing });
  assert.notEqual(failed, 0, "a failed sysctl falls back instead of reading as 0 free");
  assert.notEqual(await availableMemory(1000, { platform: "darwin", exec: async () => "nope" }), 0);
  const readFile = async () => "MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:   20000000 kB\n";
  assert.equal(await availableMemory(1000, { platform: "linux", readFile }), 20000000 * 1024);
});

test("folders are measured once each, wherever the worktrees live", () => {
  assert.deepEqual(milagreFolders({ homeDir: "/Users/me", dataDir: "/Users/me/Library/Application Support/Milagre" }), [
    path.resolve("/Users/me/.milagre"),
    path.resolve("/Users/me/Library/Application Support/Milagre"),
  ]);
  assert.deepEqual(milagreFolders({ homeDir: "/Users/me", dataDir: "/Users/me/.milagre/data", worktreeRoot: "/Users/me/.milagre/worktrees" }), [
    path.resolve("/Users/me/.milagre"),
  ]);
  assert.deepEqual(milagreFolders({ homeDir: "/Users/me", dataDir: "/Users/me/.milagre/data", worktreeRoot: "/Volumes/Work" }), [
    path.resolve("/Users/me/.milagre"),
    path.resolve("/Volumes/Work"),
  ]);
  const worktrees = path.resolve("/Users/me/.milagre/worktrees");
  const du = [
    "4\t/Users/me/.milagre/worktrees/app/one/src",
    "6\t/Users/me/.milagre/worktrees/app/one",
    "3\t/Users/me/.milagre/worktrees/app/two",
    "9\t/Users/me/.milagre/worktrees/app",
    "9\t/Users/me/.milagre/worktrees",
    "12\t/Users/me/.milagre",
    "20\t/Users/me/Library/Application Support/Milagre",
    "du: /Users/me/.milagre/locked: Permission denied",
  ].join("\n");
  const folders = milagreFolders({ homeDir: "/Users/me", dataDir: "/Users/me/Library/Application Support/Milagre" });
  assert.deepEqual(parseDu(du, { folders, worktrees }), {
    total: 32 * 1024,
    parts: [
      { kind: "worktrees", bytes: 9 * 1024, count: 2 },
      { kind: "data", bytes: 23 * 1024, count: 0 },
    ],
  });
  // Worktrees on their own volume are a measured folder and still the worktrees part.
  const elsewhere = parseDu("5\t/Volumes/Work/app/one\n5\t/Volumes/Work/app\n5\t/Volumes/Work\n7\t/Users/me/.milagre", {
    folders: [path.resolve("/Users/me/.milagre"), path.resolve("/Volumes/Work")],
    worktrees: path.resolve("/Volumes/Work"),
  });
  assert.deepEqual(elsewhere.parts, [
    { kind: "worktrees", bytes: 5 * 1024, count: 1 },
    { kind: "data", bytes: 7 * 1024, count: 0 },
  ]);
  // Output cut before the folders' own totals is no measure at all.
  assert.throws(() => parseDu("500\t/Users/me/.milagre/worktrees/app/one\n", { folders, worktrees }), /no folder's total/);
});

function fakeHost({ du }) {
  let clock = 1_000;
  const calls = { du: 0, ps: 0 };
  const exec = async (file, args, options) => {
    if (file === "sysctl") return "50";
    if (file === "ps") {
      calls.ps += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return PS;
    }
    calls.du += 1;
    return du(args, options);
  };
  const resources = createComputerResources({
    dataDir: "/Users/me/.milagre/data",
    homeDir: "/Users/me",
    exec,
    platform: "darwin",
    now: () => clock,
    totalMemory: () => 1000,
    statfs: async () => ({ blocks: 100, bavail: 40, bsize: 10 }),
    access: async () => {},
    self: { pid: 102, execPath: APP },
  });
  return {
    resources,
    calls,
    tick: (ms) => {
      clock += ms;
    },
  };
}

test("a read returns at once and measures the folders in the background, again only after half an hour", async () => {
  let finishDu;
  const { resources, calls, tick } = fakeHost({
    du: () =>
      new Promise((resolve) => {
        finishDu = () => resolve("60\t/Users/me/.milagre/worktrees\n100\t/Users/me/.milagre\n");
      }),
  });
  const first = await resources.read();
  assert.equal(first.memory.milagre, ALL);
  assert.deepEqual([first.memory.total, first.memory.available], [1000, 500]);
  assert.deepEqual(first.disk, { total: 1000, available: 400, milagre: null, parts: null, measuredAt: null, measuring: true });
  await resources.read();
  assert.equal(calls.du, 1, "a measure already running isn't started again");
  finishDu();
  await resources.measureDisk();
  const second = await resources.read();
  assert.deepEqual(second.disk, {
    total: 1000,
    available: 400,
    milagre: 100 * 1024,
    parts: [
      { kind: "worktrees", bytes: 60 * 1024, count: 0 },
      { kind: "data", bytes: 40 * 1024, count: 0 },
    ],
    measuredAt: 1_000,
    measuring: false,
  });
  tick(31 * 60_000);
  const stale = await resources.read();
  assert.equal(stale.disk.measuring, true);
  assert.equal(stale.disk.milagre, 100 * 1024, "the last measure shows while the next runs");
  assert.equal(calls.du, 2);
});

test("a measure that fails or is cut short shows nothing new and waits before trying again", async () => {
  const { resources, calls, tick } = fakeHost({
    // du killed at its timeout: subfolders printed, the folders' own totals never reached.
    du: async () => "500\t/Users/me/.milagre/worktrees/app/one\n",
  });
  await resources.read();
  // The read started the measure in the background; let it finish.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = await resources.read();
  assert.equal(after.disk.milagre, null, "not Milagre 0 KB");
  assert.equal(after.disk.measuring, false);
  for (let index = 0; index < 5; index += 1) await resources.read();
  assert.equal(calls.du, 1, "every read doesn't start du again");
  tick(DISK_RETRY + 1);
  await resources.read();
  assert.equal(calls.du, 2, "it tries again after the wait");
});

test("reads that arrive together share one process sample", async () => {
  const { resources, calls } = fakeHost({ du: async () => "100\t/Users/me/.milagre\n" });
  await Promise.all(Array.from({ length: 25 }, () => resources.read()));
  assert.equal(calls.ps, 1);
});

test("a command cut short fails even when it printed something, and closing stops a measure that runs", async (t) => {
  if (process.platform === "win32") return t.skip("no sh");
  await assert.rejects(run("sh", ["-c", "echo 10 /a; sleep 5"], { allowFailure: true, signal: AbortSignal.timeout(200) }));
  assert.equal((await run("sh", ["-c", "echo 10 /a; exit 1"], { allowFailure: true })).trim(), "10 /a", "a plain non-zero exit keeps its output");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-resources-close-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".milagre"));
  let started;
  const exec = (file, args, options) => {
    if (file !== "du") return run(file, args, options);
    started = run("sh", ["-c", "sleep 5"], options);
    return started;
  };
  const resources = createComputerResources({ dataDir: path.join(home, "data"), homeDir: home, exec });
  const measure = resources.measureDisk();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const before = Date.now();
  resources.close();
  await measure;
  await assert.rejects(started);
  assert.ok(Date.now() - before < 2_000, "du stops at close instead of running to its end");
});

test("this computer reads for real", async (t) => {
  // An empty home, so the folder measure ends at once instead of walking real worktrees.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-resources-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const resources = createComputerResources({ dataDir: path.join(home, "data"), homeDir: home });
  const { memory, disk } = await resources.read();
  assert.ok(memory.total > 0 && memory.available > 0 && memory.available <= memory.total);
  if (process.platform !== "win32") assert.ok(memory.milagre > 0);
  assert.ok(disk.total > 0 && disk.available > 0);
  await resources.measureDisk();
  resources.close();
});

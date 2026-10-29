const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { availableMemory, createComputerResources, milagreFolders, parseDu, parseProcesses, treeMemory } = require("./computer-resources.cjs");

const PS = [
  "    1     0   100 /sbin/launchd",
  "  100     1  2000 /Applications/Milagre.app/Contents/MacOS/Milagre",
  "  101   100  3000 /Applications/Milagre.app/Contents/Frameworks/Milagre Helper (Renderer).app/Contents/MacOS/Milagre Helper (Renderer)",
  "  102   100  4000 /Applications/Milagre.app/Contents/MacOS/Milagre",
  "  103   102  5000 /Users/me/.local/bin/claude",
  "  104   103   600 /bin/zsh",
  "  200     1  9000 /Applications/Safari.app/Contents/MacOS/Safari",
].join("\n");

test("Milagre's memory is the app's whole tree when the daemon runs inside it, else the daemon's own", () => {
  const processes = parseProcesses(PS);
  assert.equal(processes[2].command.endsWith("Milagre Helper (Renderer)"), true, "commands keep their spaces");
  const execPath = "/Applications/Milagre.app/Contents/MacOS/Milagre";
  assert.equal(treeMemory(processes, { pid: 102, ppid: 100, execPath }), (2000 + 3000 + 4000 + 5000 + 600) * 1024);
  // A daemon started from a shell, like mobile-host: only it and its agents.
  assert.equal(treeMemory(processes, { pid: 102, ppid: 104, execPath }), (4000 + 5000 + 600) * 1024);
  // Linux cuts the command to 15 characters.
  const linux = parseProcesses("  10     1  100 milagre-daemon-\n  11    10  200 milagre-daemon-\n  12    11  300 claude");
  assert.equal(treeMemory(linux, { pid: 11, ppid: 10, execPath: "/opt/milagre/milagre-daemon-bin" }), 600 * 1024);
  // launchd is never the root, whatever it is called.
  assert.equal(treeMemory(processes, { pid: 100, ppid: 1, execPath: "/sbin/launchd" }), (2000 + 3000 + 4000 + 5000 + 600) * 1024);
});

test("free memory on a Mac comes from the kernel's level, not os.freemem()", async () => {
  const exec = async (file, args) => {
    assert.deepEqual([file, ...args], ["sysctl", "-n", "kern.memorystatus_level"]);
    return "54\n";
  };
  assert.equal(await availableMemory(1000, { platform: "darwin", exec }), 540);
  const broken = await availableMemory(1000, { platform: "darwin", exec: async () => "nope" });
  assert.equal(typeof broken, "number");
});

test("folders are measured once each, a nested data folder inside ~/.milagre isn't counted twice", () => {
  assert.deepEqual(milagreFolders({ homeDir: "/Users/me", dataDir: "/Users/me/Library/Application Support/Milagre" }), [
    path.resolve("/Users/me/.milagre"),
    path.resolve("/Users/me/Library/Application Support/Milagre"),
  ]);
  assert.deepEqual(milagreFolders({ homeDir: "/Users/me", dataDir: "/Users/me/.milagre/data" }), [path.resolve("/Users/me/.milagre")]);
  assert.equal(parseDu("10\t/a\n20\t/b\ndu: /c: Permission denied\n"), 30 * 1024);
});

test("a read returns at once and measures the folders in the background, again only after half an hour", async () => {
  let clock = 1_000;
  const duCalls = [];
  let finishDu;
  const exec = async (file, args) => {
    if (file === "sysctl") return "50";
    if (file === "ps") return PS;
    duCalls.push(args);
    return new Promise((resolve) => {
      finishDu = () => resolve("100\t/Users/me/.milagre\n");
    });
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
    self: { pid: 102, ppid: 100, execPath: "/Applications/Milagre.app/Contents/MacOS/Milagre" },
  });
  const first = await resources.read();
  assert.deepEqual(first.memory, { total: 1000, available: 500, milagre: 14600 * 1024 });
  assert.deepEqual(first.disk, { total: 1000, available: 400, milagre: null, measuredAt: null, measuring: true });
  await resources.read();
  assert.equal(duCalls.length, 1, "a measure already running isn't started again");
  finishDu();
  await resources.measureDisk();
  const second = await resources.read();
  assert.deepEqual(second.disk, { total: 1000, available: 400, milagre: 100 * 1024, measuredAt: 1_000, measuring: false });
  clock += 31 * 60_000;
  const stale = await resources.read();
  assert.equal(stale.disk.measuring, true);
  assert.equal(stale.disk.milagre, 100 * 1024, "the last measure shows while the next runs");
  assert.equal(duCalls.length, 2);
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
});

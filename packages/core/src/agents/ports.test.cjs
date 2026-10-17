const assert = require("node:assert/strict");
const test = require("node:test");
const { PortWatcher, chatPorts, chatProcesses, parseLsof, parsePs } = require("./ports.cjs");

// The agent (100) leads group 100 with its MCP server (101); its command shells lead their own groups.
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

test("reads ps and lsof output", () => {
  assert.deepEqual(parsePs(PS)[1], { pid: 100, ppid: 50, pgid: 100, command: "/Users/me/.local/bin/claude" });
  assert.deepEqual(parseLsof(LSOF), [
    { pid: 101, command: "node", port: 4545, address: "127.0.0.1" },
    { pid: 111, command: "node", port: 5173, address: "*" },
    { pid: 111, command: "node", port: 24678, address: "127.0.0.1" },
    { pid: 211, command: "Python", port: 8000, address: "*" },
  ]);
});

test("a chat owns what its command shells started, not the agent's MCP servers", () => {
  const groups = new Map();
  const byChat = chatProcesses(
    parsePs(PS),
    new Map([
      ["/a#1", { pid: 100 }],
      ["/b#2", { pid: 200 }],
    ]),
    groups,
  );
  assert.deepEqual([...byChat.get("/a#1")].sort(), [110, 111, 112]);
  assert.deepEqual([...byChat.get("/b#2")].sort(), [210, 211]);
  assert.deepEqual(chatPorts(parseLsof(LSOF), byChat), {
    "/a#1": [
      { port: 5173, pid: 111, command: "node", address: "*" },
      { port: 24678, pid: 111, command: "node", address: "127.0.0.1" },
    ],
    "/b#2": [{ port: 8000, pid: 211, command: "Python", address: "*" }],
  });
});

test("a Chat's Terminal shells count as its roots, with or without an agent", () => {
  // The Terminal's shell (300) runs a dev server (301) in its own job's group.
  const ps = `${PS}  300    50   300 /opt/homebrew/bin/fish\n  301   300   301 node\n`;
  const byChat = chatProcesses(
    parsePs(ps),
    new Map([
      ["/a#1", { pid: 100, shells: [300] }],
      ["/c#3", { shells: [300] }],
    ]),
    new Map(),
  );
  assert.deepEqual([...byChat.get("/a#1")].sort(), [110, 111, 112, 300, 301]);
  assert.deepEqual([...byChat.get("/c#3")].sort(), [300, 301]);
});

test("stopping a Terminal's port in the shell's own group leaves the shell running", async () => {
  const killed = [];
  const ps = "    1     0     1 /sbin/launchd\n  300    50   300 /bin/zsh\n  301   300   300 node\n";
  const watcher = new PortWatcher({
    platform: "darwin",
    roots: () => new Map([["/c#3", { shells: [300] }]]),
    publish: () => {},
    exec: async (command) => (command === "ps" ? ps : "p301\ncnode\nn*:3000\n"),
    kill: (pid, signal) => {
      if (signal === 0) throw new Error("gone");
      killed.push(pid);
    },
    graceMs: 0,
  });
  await watcher.poll();
  watcher.close();
  assert.equal(await watcher.stopPort("/c#3", 301), true);
  assert.deepEqual(killed, [301]);
});

test("a server that outlived its shell and its agent stays with the chat until it stops", () => {
  const groups = new Map();
  chatProcesses(parsePs(PS), new Map([["/a#1", { pid: 100 }]]), groups);
  // The shell exited and the server was reparented to launchd; then the agent's session closed.
  const orphaned = parsePs("    1     0     1 /sbin/launchd\n  111     1   110 node\n");
  assert.deepEqual([...chatProcesses(orphaned, new Map(), groups).get("/a#1")], [111]);
  assert.equal(chatProcesses(parsePs("    1     0     1 /sbin/launchd\n"), new Map(), groups).size, 0);
  assert.equal(groups.size, 0);
});

test("Chats sharing a Worktree never acquire each other's orphaned ports", async (t) => {
  let ps = PS;
  const roots = new Map([
    ["/repo#1", { pid: 100, cwd: "/repo" }],
    ["/repo#2", { pid: 200, cwd: "/repo" }],
  ]);
  const signals = [];
  const watcher = new PortWatcher({
    roots: () => roots,
    publish() {},
    kill: (...args) => signals.push(args),
    exec: async (command, args) => (command === "ps" ? ps : args.includes("cwd") ? "p111\nn/repo/web\np300\nn/repo/web\n" : LSOF + "p300\ncnode\nn*:9000\n"),
  });
  t.after(() => watcher.close());
  await watcher.poll();
  ps = PS.replace(/^.*\b11[012]\b.*$/gm, "") + "111 1 110 node\n300 1 299 node\n";
  await watcher.poll({ fresh: true });
  assert.deepEqual(
    watcher.snapshot()["/repo#1"].map((p) => p.port),
    [5173, 24678],
  );
  assert.deepEqual(
    watcher.snapshot()["/repo#2"].map((p) => p.port),
    [8000],
  );
  assert.equal(await watcher.stopPort("/repo#2", 111), false);
  assert.equal(await watcher.stopPort("/repo#2", 300), false);
  assert.deepEqual(signals, []);
});

test("the watcher publishes changes and stops once nothing runs", async () => {
  let roots = new Map([["/a#1", { pid: 100 }]]);
  let ps = PS;
  const published = [];
  const calls = [];
  const watcher = new PortWatcher({
    roots: () => roots,
    publish: (ports) => published.push(ports),
    pollMs: 60_000,
    exec: async (command, args) => {
      calls.push(command);
      if (command === "ps") return ps;
      assert.equal(args[args.indexOf("-p") + 1], "110,111,112");
      return LSOF;
    },
  });
  await watcher.poll();
  assert.deepEqual(Object.keys(published[0]), ["/a#1"]);
  await watcher.poll();
  assert.equal(published.length, 1, "an unchanged poll publishes nothing");
  roots = new Map();
  ps = "    1     0     1 /sbin/launchd\n";
  await watcher.poll();
  assert.deepEqual(published.at(-1), {});
  assert.deepEqual(watcher.snapshot(), {});
  assert.equal(watcher.timer, null, "no agents and no servers left: polling stops");
  calls.length = 0;
  await watcher.poll();
  assert.deepEqual(calls, [], "nothing to watch runs nothing");
});

test("stopping a port ends its command's group, and only a pid the chat shows", async () => {
  const signals = [];
  let alive = true;
  const watcher = new PortWatcher({
    roots: () => new Map([["/a#1", { pid: 100 }]]),
    publish: () => {},
    pollMs: 60_000,
    graceMs: 200,
    exec: async (command) => (command === "ps" ? (alive ? PS : PS.replace(/^.*\b11[012]\b.*$/gm, "")) : alive ? LSOF : ""),
    kill: (target, signal) => {
      signals.push([target, signal]);
      if (signal === "SIGTERM") alive = false;
      if (signal === 0 && !alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
  });
  await watcher.poll();
  assert.equal(await watcher.stopPort("/a#1", 101), false, "the agent's own MCP server isn't the chat's to stop");
  assert.equal(await watcher.stopPort("/b#2", 111), false, "another chat can't stop it");
  assert.deepEqual(signals, []);
  assert.equal(await watcher.stopPort("/a#1", 111), true);
  assert.deepEqual(signals[0], [-110, "SIGTERM"], "the whole command's group gets SIGTERM");
  assert.ok(!signals.some(([, signal]) => signal === "SIGKILL"), "no SIGKILL when SIGTERM was enough");
  assert.deepEqual(watcher.snapshot(), {}, "the list is fresh once it resolves");
  watcher.close();
});

test("a stop during a poll waits for it and reads again, so the stopped server is gone when it resolves", async () => {
  let alive = true;
  let release;
  const published = [];
  const watcher = new PortWatcher({
    roots: () => new Map([["/a#1", { pid: 100 }]]),
    publish: (ports) => published.push(ports),
    pollMs: 60_000,
    graceMs: 200,
    exec: async (command) => {
      const listing = command === "ps" ? (alive ? PS : PS.replace(/^.*\b11[012]\b.*$/gm, "")) : alive ? LSOF : "";
      // The poll already running read the listeners before the server died, and hasn't published them yet.
      if (command === "lsof" && release === null) return new Promise((resolve) => (release = () => resolve(listing)));
      return listing;
    },
    kill: (target, signal) => {
      if (signal === "SIGTERM") alive = false;
      if (signal === 0 && !alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
  });
  await watcher.poll();
  release = null;
  const running = watcher.poll({ fresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = watcher.stopPort("/a#1", 111);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal(await stopped, true);
  await running;
  assert.deepEqual(watcher.snapshot(), {}, "the stale read in flight doesn't stand as the list Stop resolves with");
  assert.deepEqual(published.at(-1), {});
  watcher.close();
});

test("a port that ignores SIGTERM gets SIGKILL", async () => {
  const signals = [];
  const watcher = new PortWatcher({
    roots: () => new Map([["/a#1", { pid: 100 }]]),
    publish: () => {},
    pollMs: 60_000,
    graceMs: 100,
    exec: async (command) => (command === "ps" ? PS : LSOF),
    kill: (target, signal) => signals.push([target, signal]),
  });
  await watcher.poll();
  await watcher.stopPort("/a#1", 111);
  assert.deepEqual(signals.at(-1), [-110, "SIGKILL"]);
  watcher.close();
});

test("idle agent ports poll every 15 seconds and wake immediately for a new turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let running = false,
    calls = 0;
  const watcher = new PortWatcher({
    roots: () => new Map([["/a#1", { pid: 100 }]]),
    isRunning: () => running,
    publish: () => {},
    exec: async (command) => {
      if (command === "ps") {
        calls++;
        return PS;
      }
      return LSOF;
    },
  });
  t.after(() => watcher.close());
  await watcher.poll();
  assert.equal(calls, 1);
  t.mock.timers.tick(14999);
  await Promise.resolve();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(calls, 2);
  running = true;
  watcher.wake();
  t.mock.timers.tick(1);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(calls, 3);
  t.mock.timers.tick(3000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(calls, 4);
});

test("closing during a port poll does not publish or restart polling", async () => {
  let release;
  const result = new Promise((resolve) => (release = resolve));
  const published = [];
  const watcher = new PortWatcher({
    roots: () => new Map([["/a#1", { pid: 100 }]]),
    publish: (p) => published.push(p),
    exec: async (command) => (command === "ps" ? result : LSOF),
  });
  const poll = watcher.poll();
  watcher.close();
  release(PS);
  await poll;
  assert.equal(watcher.timer, null);
  assert.deepEqual(published, []);
});

test("lsof runs when a chat's pids change or every 10 seconds, ps on every poll", async () => {
  let clock = 0;
  let ps = PS;
  const calls = [];
  const published = [];
  const watcher = new PortWatcher({
    roots: () => new Map([["/a#1", { pid: 100 }]]),
    publish: (ports) => published.push(ports),
    pollMs: 60_000,
    now: () => clock,
    exec: async (command) => {
      calls.push(command);
      return command === "ps" ? ps : LSOF;
    },
  });
  await watcher.poll();
  assert.deepEqual(calls, ["ps", "lsof"]);
  clock = 3000;
  await watcher.poll();
  clock = 6000;
  await watcher.poll();
  assert.deepEqual(calls, ["ps", "lsof", "ps", "ps"], "unchanged pids reuse the last listeners");
  assert.equal(published.length, 1);
  clock = 10_000;
  await watcher.poll();
  assert.deepEqual(calls.slice(4), ["ps", "lsof"], "the listeners are re-read once they are 10 seconds old");
  // A new process in the command's group changes the pid set: read at once.
  ps = PS + "  113   110   110 node\n";
  clock = 11_000;
  await watcher.poll();
  assert.deepEqual(calls.slice(6), ["ps", "lsof"]);
  assert.equal(published.length, 1, "same ports, nothing published");
  watcher.close();
});

test("a chat with no processes needs no lsof, and stopping a port reads the listeners afresh", async () => {
  let clock = 0;
  let alive = true;
  const calls = [];
  const watcher = new PortWatcher({
    roots: () => new Map([["/a#1", { pid: 100 }]]),
    publish: () => {},
    pollMs: 60_000,
    graceMs: 100,
    now: () => clock,
    exec: async (command) => {
      calls.push(command);
      return command === "ps" ? PS : alive ? LSOF : "";
    },
    kill: (target, signal) => {
      if (signal === "SIGTERM") alive = false;
    },
  });
  await watcher.poll();
  clock = 1000;
  calls.length = 0;
  await watcher.stopPort("/a#1", 111);
  assert.ok(calls.includes("lsof"), "stopping a port re-reads the listeners even though the pids look the same");
  assert.deepEqual(watcher.snapshot(), {});
  watcher.close();
  const none = [];
  const idle = new PortWatcher({
    roots: () => new Map([["/z#1", { pid: 100 }]]),
    publish: () => {},
    exec: async (command) => {
      none.push(command);
      return command === "ps" ? "  100  50  100 claude\n" : "";
    },
  });
  await idle.poll();
  assert.deepEqual(none, ["ps"]);
  idle.close();
});

test("ports compare by value without serializing", async () => {
  const published = [];
  let reads = 0;
  const watcher = new PortWatcher({
    roots: () => new Map([["/a#1", { pid: 100 }]]),
    publish: (ports) => published.push(ports),
    pollMs: 60_000,
    lsofMaxAgeMs: 0,
    exec: async (command) => (command === "ps" ? PS : ++reads < 3 ? LSOF : LSOF.replace("n*:5173", "n*:5174")),
  });
  await watcher.poll();
  await watcher.poll();
  assert.equal(published.length, 1);
  await watcher.poll();
  assert.equal(published.length, 2, "a port change is published");
  watcher.close();
});

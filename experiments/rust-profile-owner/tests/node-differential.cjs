// The Node side of the profile owner's differential test (tests/node_differential.rs drives it).
//
//   node node-differential.cjs setup <isolation>            make throwaway Projects with saved Chats and a data dir
//   node node-differential.cjs prime <isolation>            start this repo's Node daemon, register the Projects, stop it
//   node node-differential.cjs record <isolation> <out>     start the Node daemon, record the reads, stop it
//   node node-differential.cjs compare <isolation> <base>   record the reads from the owner running now (the Rust one),
//                                                          compare them with <base>, and check Node can't serve meanwhile
//   node node-differential.cjs stop <isolation>             daemon:stop the owner running now
//   node node-differential.cjs hold <isolation>             start the Node daemon and keep it until stdin ends
//   node node-differential.cjs same <isolation> <a> <b>     two recordings answer the same (normalized)
//
// Everything lives under <isolation>: the data dir (profile), HOME, the chats home, the Worktree root and the Projects.
// No provider, account or network is used: the Chats are written with Node's own saveProjectState.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const readline = require("node:readline");

const repo = path.resolve(__dirname, "../../..");
const { connect } = require(path.join(repo, "apps/daemon/src/client.cjs"));
const cli = path.join(repo, "apps/daemon/src/cli.cjs");

const [command, isolationArg, outArg] = process.argv.slice(2);
const root = fs.realpathSync(isolationArg);
const layout = {
  dataDir: path.join(root, "profile"),
  home: path.join(root, "home"),
  chatsHome: path.join(root, "chats"),
  worktreeRoot: path.join(root, "worktrees"),
  alpha: path.join(root, "projects", "alpha"),
  beta: path.join(root, "projects", "beta"),
};
const VERSION = "0.0.0-test";

// A child environment with nothing that could reach a real profile, account or provider.
function cleanEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(ELECTRON_|MILAGRE_|CLAUDE_|CODEX_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|GIT_)/.test(name)) continue;
    if (/TOKEN|SECRET|API_KEY|PASSWORD/.test(name)) continue;
    env[name] = value;
  }
  env.HOME = layout.home;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

const DATE = Date.parse("2026-11-01T10:00:00.000Z");
function seedAlpha(project) {
  const detail = Array.from({ length: 80 }, (_, line) => `test ${line} ok — café 日本語`).join("\n");
  return {
    next_id: 40,
    worktrees: { 1: { id: 1, path: project, name: "alpha" } },
    sessions: {
      1: { id: 1, worktree_id: 1, title: "Parser fix", provider: "claude", model: "claude-opus-5-5", unread: true },
      2: {
        id: 2,
        worktree_id: 1,
        title: "Unicode — İstanbul 日本語 😀",
        provider: "codex",
        subagents: [
          {
            id: "helper",
            title: "helper",
            status: "completed",
            transcript: [
              { id: "e1", kind: "message", text: "hello from the helper" },
              { id: "e2", kind: "tool", text: "z".repeat(3000) },
            ],
          },
        ],
      },
      3: { id: 3, worktree_id: 1, title: "Old work", archived: true },
    },
    messages: [
      { id: 1, session_id: 1, role: "user", body: "Fix the parser please", clientMessageId: "cm-1", createdAt: DATE },
      {
        id: 2,
        session_id: 1,
        role: "assistant",
        body: "Parsing works now.",
        outcome: "completed",
        createdAt: DATE + 1000,
        steps: [{ id: "s1", kind: "shell", title: "npm test", status: "completed", detail }],
      },
      { id: 3, session_id: 1, role: "user", body: "And the edge cases?", clientMessageId: "cm-3", createdAt: DATE + 2000 },
      { id: 4, session_id: 1, role: "assistant", body: "Covered: naïve café input.", outcome: "completed", createdAt: DATE + 3000 },
      { id: 5, session_id: 1, role: "user", body: "Thanks", clientMessageId: "cm-5", createdAt: DATE + 4000 },
      { id: 6, session_id: 1, role: "assistant", body: "Anytime.", outcome: "completed", createdAt: DATE + 5000 },
      { id: 7, session_id: 2, role: "user", body: "Look at İstanbul and 日本語 text 😀", clientMessageId: "cm-7", createdAt: DATE + 6000 },
      { id: 8, session_id: 2, role: "assistant", body: "Ran the helper.", outcome: "completed", createdAt: DATE + 7000 },
      { id: 9, session_id: 3, role: "user", body: "Archived question", clientMessageId: "cm-9", createdAt: DATE + 8000 },
      { id: 10, session_id: 3, role: "assistant", body: "Archived answer", outcome: "failed", createdAt: DATE + 9000 },
    ],
  };
}
function seedBeta(project) {
  return {
    next_id: 20,
    worktrees: { 1: { id: 1, path: project, name: "beta" } },
    sessions: { 1: { id: 1, worktree_id: 1, title: "Git Project chat", provider: "claude" } },
    messages: [
      { id: 11, session_id: 1, role: "user", body: "What does main hold?", clientMessageId: "cm-11", createdAt: DATE + 10000 },
      { id: 12, session_id: 1, role: "assistant", body: "One empty commit.", outcome: "completed", createdAt: DATE + 11000 },
    ],
  };
}

async function setup() {
  for (const folder of [layout.dataDir, layout.home, layout.alpha, layout.beta]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      env: cleanEnv(),
      stdio: "pipe",
    });
  git("init", "-q", "-b", "main", layout.beta);
  git("-C", layout.beta, "commit", "-q", "--allow-empty", "-m", "init");
  // project:known and project:recent carry each Git Project's origin.
  git("-C", layout.beta, "remote", "add", "origin", "git@github.com:Example/Beta.git");
  const { saveProjectState } = require(path.join(repo, "packages/core/src/project-store.cjs"));
  await saveProjectState(layout.alpha, seedAlpha(layout.alpha));
  await saveProjectState(layout.beta, seedBeta(layout.beta));
  console.log(JSON.stringify(layout));
}

// Starts this repo's Node daemon on the data dir; resolves with the child once it printed its ready line.
async function startNode() {
  const child = spawn(
    process.execPath,
    [
      cli,
      "serve",
      "--data-dir",
      layout.dataDir,
      "--app-version",
      VERSION,
      "--cwd",
      "/",
      "--chats-home",
      layout.chatsHome,
      "--worktree-root",
      layout.worktreeRoot,
    ],
    { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-8192)));
  const lines = readline.createInterface({ input: child.stdout });
  const ready = await Promise.race([
    once(lines, "line").then(([line]) => JSON.parse(line)),
    exited.then(([code]) => {
      throw new Error(`Node daemon exited (${code}) before it was ready:\n${stderr}`);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Node daemon start timed out:\n${stderr}`)), 30000).unref()),
  ]);
  return { child, exited, ready, stderr: () => stderr };
}
async function stopNode(node) {
  const client = await connect({ dataDir: layout.dataDir });
  try {
    assert.deepEqual(await client.call("daemon:stop", []), { stopping: true });
  } finally {
    client.close();
  }
  const [code] = await node.exited;
  assert.equal(code, 0, node.stderr());
}

// Node refuses to serve while another owner holds the data dir.
function nodeRefuses() {
  try {
    execFileSync(
      process.execPath,
      [
        cli,
        "serve",
        "--data-dir",
        layout.dataDir,
        "--app-version",
        VERSION,
        "--cwd",
        "/",
        "--chats-home",
        layout.chatsHome,
        "--worktree-root",
        layout.worktreeRoot,
      ],
      { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
    );
  } catch (error) {
    assert.notEqual(error.status, 0);
    assert.match(String(error.stderr), /Milagre state is already owned/);
    return String(error.stderr).trim();
  }
  throw new Error("Node served a data dir another owner holds");
}

async function call(client, method, args) {
  try {
    return { method, args, result: await client.call(method, args) };
  } catch (error) {
    return { method, args, error: { code: error.code, message: error.message } };
  }
}

// The reads compared between owners, in one fixed order (the order Projects load in decides the snapshot's order).
async function record(client) {
  const { alpha, beta } = layout;
  const cases = [];
  const add = async (method, args) => cases.push(await call(client, method, args));
  await add("project:known", []);
  await add("project:recent", []);
  // A recent Project nobody opened yet: its Chat is read from chats.db without opening it.
  await add("chat:messages", [alpha, 1, {}]);
  await add("chat:messages", [alpha, 2, { turns: 1 }]);
  await add("state:read", [alpha]);
  await add("project:snapshot", [alpha]);
  await add("chat:message", [alpha, 2]);
  await add("project:read", [alpha, { state: false }]);
  await add("project:read", [alpha]);
  await add("project:read", [beta, { state: true }]);
  await add("project:read", [beta, { state: false }]);
  await add("project:snapshot", [alpha]);
  await add("state:read", [beta]);
  for (const [scope, chat, options] of [
    [alpha, 1, {}],
    [alpha, 1, { turns: 1 }],
    [alpha, 1, { limit: 2 }],
    [alpha, 1, { before: 5, turns: 1 }],
    [alpha, 2, {}],
    [alpha, 3, {}],
    [alpha, 99, {}],
    [beta, 1, {}],
  ])
    await add("chat:messages", [scope, chat, options]);
  await add("chat:message", [alpha, 2]);
  await add("chat:message", [alpha, 8]);
  await add("chat:message", [beta, 12]);
  await add("chat:message", [alpha, 12345]);
  await add("chat:runs", []);
  // Refusals: a folder Milagre never opened, a Project not open, nothing at all, an unknown command.
  await add("project:read", [path.join(root, "projects")]);
  await add("project:read", []);
  await add("state:read", [""]);
  await add("chat:messages", [path.join(root, "projects"), 1, {}]);
  await add("nope:nothing", []);
  const snapshot = await client.call("daemon:snapshot", []);
  // The paged form a desktop reads: the same body in pages.
  const manifest = await client.call("daemon:snapshot", [{ paged: true }]);
  const parts = [];
  for (let index = 0; index < manifest.pageCount; index++) parts.push(await client.call("daemon:snapshot-page", [manifest.snapshotId, index]));
  const paged = JSON.parse(parts.join(""));
  assert.equal(paged.eventSeq, manifest.eventSeq);
  assert.deepEqual({ ...paged, eventSeq: 0 }, { ...snapshot, eventSeq: 0 });
  cases.push({ method: "daemon:snapshot", args: [], result: snapshot });
  return cases;
}

// Only what legitimately differs between two owners (or two runs of one): each host numbers its states in its own
// epoch, and its event sequence counts its own events.
const NORMALIZED = [
  "project:read / project:snapshot / state:read: `epoch` (a random id per host run) and `version` (the number of the state that host last sent)",
  "daemon:snapshot: `eventSeq` (events that host published)",
];
function normalize(cases) {
  return cases.map((item) => {
    if (!item.result || typeof item.result !== "object" || Array.isArray(item.result)) return item;
    const result = { ...item.result };
    if (["project:read", "project:snapshot", "state:read"].includes(item.method)) {
      assert.equal(typeof result.epoch, "string", `${item.method} epoch`);
      assert.ok(Number.isSafeInteger(result.version) && result.version >= 1, `${item.method} version`);
      result.epoch = "<epoch>";
      result.version = "<version>";
    }
    if (item.method === "daemon:snapshot") {
      assert.ok(Number.isSafeInteger(result.eventSeq));
      result.eventSeq = "<eventSeq>";
    }
    return { ...item, result };
  });
}

async function main() {
  if (command === "setup") return setup();
  if (command === "prime") {
    const node = await startNode();
    const client = await connect({ dataDir: layout.dataDir });
    try {
      // Registered and remembered as the desktop registers them; Node reconciles and saves each on its first load.
      for (const project of [layout.alpha, layout.beta]) await client.call("project:open", [project]);
      await client.call("project:set-hidden", [layout.beta, true]);
      await client.call("project:known", []);
      await client.call("daemon:flush", []);
    } finally {
      client.close();
    }
    await stopNode(node);
    console.log("primed");
    return;
  }
  if (command === "record") {
    const node = await startNode();
    const client = await connect({ dataDir: layout.dataDir });
    let cases;
    try {
      const status = await client.call("daemon:status", []);
      assert.equal(status.pid, node.child.pid);
      cases = await record(client);
    } finally {
      client.close();
    }
    await stopNode(node);
    fs.writeFileSync(outArg, JSON.stringify(cases, null, 2));
    console.log(`recorded ${cases.length} Node cases`);
    return;
  }
  if (command === "compare") {
    const base = normalize(JSON.parse(fs.readFileSync(outArg, "utf8")));
    const client = await connect({ dataDir: layout.dataDir });
    let cases, status;
    try {
      status = await client.call("daemon:status", []);
      cases = normalize(await record(client));
    } finally {
      client.close();
    }
    // The owner answering is the Rust profile owner, in the Node daemon's status shape.
    assert.deepEqual(Object.keys(status), ["pid", "version", "protocolVersion", "dataDir", "socketPath", "closing", "capabilities", "methods"]);
    assert.equal(status.version, VERSION);
    assert.equal(status.protocolVersion, 1);
    assert.equal(status.dataDir, fs.realpathSync(layout.dataDir));
    assert.equal(status.closing, false);
    assert.deepEqual(status.capabilities, ["snapshot-pages-v1", "result-pages-v1"]);
    assert.deepEqual(status.methods, [
      "chat:message",
      "chat:messages",
      "chat:runs",
      "chat:set-open",
      "daemon:focus",
      "daemon:result-page",
      "daemon:snapshot",
      "daemon:snapshot-page",
      "daemon:status",
      "daemon:stop",
      "project:known",
      "project:read",
      "project:recent",
      "project:snapshot",
      "state:read",
    ]);
    // The recording covers what it is meant to: a Git Project's origin, a hidden Project, a step detail in a sidecar.
    const beta = (list) => list.find((project) => project.path === layout.beta);
    assert.equal(beta(base[0].result).origin, "github.com/example/beta");
    assert.equal(beta(base[1].result).hidden, true);
    assert.equal(beta(base[1].result).origin, "github.com/example/beta");
    assert.ok(base.find((item) => item.method === "chat:message" && item.result?.steps)?.result.steps[0].detail.length > 1024);
    if (process.env.PROFILE_OWNER_DUMP) fs.writeFileSync(process.env.PROFILE_OWNER_DUMP, JSON.stringify(cases, null, 2));
    assert.equal(cases.length, base.length);
    for (let index = 0; index < base.length; index++) {
      const label = `case ${index}: ${base[index].method} ${JSON.stringify(base[index].args)}`;
      assert.deepStrictEqual(cases[index], base[index], label);
      // Key order too: the text a client parses is Node's.
      assert.equal(JSON.stringify(cases[index]), JSON.stringify(base[index]), `${label} (key order)`);
    }
    const refusal = nodeRefuses();
    console.log(`differential passed: ${cases.length} cases equal to Node's, key order included`);
    console.log(`normalized: ${NORMALIZED.join("; ")}`);
    console.log(`node refused while the Rust owner ran: ${refusal.split("\n")[0]}`);
    return;
  }
  if (command === "same") {
    const [first, second] = process.argv.slice(4);
    const a = normalize(JSON.parse(fs.readFileSync(first, "utf8")));
    const b = normalize(JSON.parse(fs.readFileSync(second, "utf8")));
    assert.equal(a.length, b.length);
    for (let index = 0; index < a.length; index++)
      assert.deepStrictEqual(b[index], a[index], `case ${index}: ${a[index].method} ${JSON.stringify(a[index].args)}`);
    console.log(`rollback passed: Node answers the ${a.length} cases as before the Rust runs`);
    return;
  }
  if (command === "stop") {
    const client = await connect({ dataDir: layout.dataDir });
    try {
      assert.deepEqual(await client.call("daemon:stop", []), { stopping: true });
    } finally {
      client.close();
    }
    console.log("stopped");
    return;
  }
  if (command === "hold") {
    const node = await startNode();
    console.log(JSON.stringify(node.ready));
    process.stdin.resume();
    await once(process.stdin, "end");
    await stopNode(node);
    return;
  }
  throw new Error(`Unknown command ${command}`);
}
main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

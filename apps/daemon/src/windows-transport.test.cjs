const test = require("node:test");
const { readProjectState: readSavedState } = require("@milagre/core/project-store");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { startDaemon } = require("./server.cjs");
const { connect } = require("./client.cjs");
const { readToken, tokenPath } = require("./local-auth.cjs");

test("an unpublished token reports ENOENT while its private directory is still being secured", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-auth-unready-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const directory = path.dirname(tokenPath(dataDir));
  await fs.mkdir(directory, { mode: 0o755 });
  await fs.chmod(directory, 0o755);
  assert.throws(() => readToken(dataDir), { code: "ENOENT" });
});

test("Windows detached bootstrap attaches to fresh authenticated profiles repeatedly", { skip: process.platform !== "win32", timeout: 120000 }, async (t) => {
  const { ensureDaemon } = require("./bootstrap.cjs");
  const clients = [];
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-native-bootstrap-")));
  t.after(async () => {
    for (const client of clients) {
      try {
        await client.call("daemon:stop");
      } catch {}
      client.close();
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  for (let index = 0; index < 3; index++) {
    const dataDir = path.join(directory, "profile-" + index);
    const client = await ensureDaemon({ dataDir, version: "native-bootstrap", cwd: directory, startupTimeoutMs: 30000 });
    clients.push(client);
    const status = await client.call("daemon:status");
    assert.equal(status.version, "native-bootstrap");
    assert.equal(status.dataDir, dataDir);
    assert.notEqual(status.pid, process.pid);
    const reconnected = await connect({ dataDir });
    clients.push(reconnected);
    assert.equal((await reconnected.call("daemon:status")).pid, status.pid);
  }
});

async function fixture(t, options = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-auth-")));
  const daemon = await startDaemon({
    dataDir,
    version: "test",
    requireAuthentication: true,
    runtimeOptions: { cwd: dataDir, environmentReady: Promise.resolve(), titleModels: {} },
    ...options,
  });
  t.after(async () => {
    await daemon.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, daemon };
}

test("authenticated transport rejects commands before auth and emits no events to strangers", async (t) => {
  const { dataDir, daemon } = await fixture(t);
  const socket = net.createConnection(daemon.socketPath);
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const frames = [];
  socket.on("data", (chunk) => frames.push(...String(chunk).trim().split("\n").map(JSON.parse)));
  const client = await connect({ dataDir, requireAuthentication: true });
  t.after(() => client.close());
  assert.equal((await client.call("daemon:status")).version, "test");
  await client.call("daemon:focus", [{ focused: true }]);
  assert.equal(frames.length, 0);
  const ended = once(socket, "close");
  socket.write(
    JSON.stringify({ v: 1, id: 1, method: "daemon:status", args: [] }) +
      "\n" +
      JSON.stringify({ v: 1, id: 2, method: "daemon:authenticate", args: [readToken(dataDir)] }) +
      "\n",
  );
  await ended;
  assert.deepEqual(
    frames.map((frame) => frame.error?.code),
    ["UNAUTHORIZED"],
  );
});

test("bad authentication fails closed and idle unauthenticated clients expire", async (t) => {
  const { daemon } = await fixture(t, { authTimeoutMs: 30 });
  const bad = net.createConnection(daemon.socketPath);
  t.after(() => bad.destroy());
  await once(bad, "connect");
  const reply = once(bad, "data");
  bad.write(JSON.stringify({ v: 1, id: 1, method: "daemon:authenticate", args: ["f".repeat(64)] }) + "\n");
  assert.equal(JSON.parse(String((await reply)[0])).error.code, "UNAUTHORIZED");
  const idle = net.createConnection(daemon.socketPath);
  t.after(() => idle.destroy());
  await once(idle, "connect");
  await once(idle, "close");
});

test("Windows named pipe and token ACL work on the real OS", { skip: process.platform !== "win32" }, async (t) => {
  const { dataDir, daemon } = await fixture(t);
  assert.match(daemon.socketPath, /^\\\\\.\\pipe\\milagre-/);
  const { windowsAcl } = require("@milagre/core/private-files");
  windowsAcl(tokenPath(dataDir));
  const client = await connect({ dataDir });
  t.after(() => client.close());
  assert.equal((await client.call("daemon:status")).dataDir, dataDir);
  assert.equal((await client.call("daemon:snapshot")).projects.length, 0);
});

test("authenticated daemon runs fixture turns, persists replies, reconnects and cancels", async (t) => {
  const { execFileSync } = require("node:child_process");
  const { CodexSession } = require("@milagre/core/agents/codex-provider");
  const { CodexRpc } = require("@milagre/core/agents/codex-rpc");
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-lifecycle-")));
  const dataDir = path.join(directory, "profile");
  const project = path.join(directory, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  let scenario = "reply";
  const processes = [];
  const fake = require.resolve("@milagre/core/agents/fixtures/fake-app-server");
  const cli = Object.assign(async () => ({ command: process.execPath }), { invalidate() {} });
  const options = {
    dataDir,
    version: "fixture",
    requireAuthentication: true,
    runtimeOptions: {
      cwd: project,
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: cli,
      createSession(_provider, options) {
        const session = new CodexSession({
          ...options,
          createRpc: (options) => new CodexRpc({ ...options, args: [fake], env: { ...process.env, FAKE_SCENARIO: scenario } }),
        });
        processes.push(session);
        return session;
      },
    },
  };
  let daemon;
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.close());
    await daemon?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function attach() {
    const client = await connect({ dataDir, requireAuthentication: true });
    clients.push(client);
    return client;
  }
  async function until(read) {
    for (let i = 0; i < 500; i++) {
      const result = await read();
      if (result) return result;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Fixture turn did not settle");
  }
  daemon = await startDaemon(options);
  let client = await attach();
  const events = [];
  client.on("event", (event) => events.push(event));
  const opened = await client.call("project:open", [project]);
  const chat = Object.values(opened.state.sessions)[0];
  const request = { projectPath: project, sessionId: chat.id, body: "Hello fixture", provider: "codex", model: "fixture", permissionMode: "auto" };
  await client.call("chat:send", [request]);
  await until(() => events.find((e) => e.channel === "agent:event" && e.payload.event.type === "turn-completed"));
  await client.call("daemon:flush");
  let state = (await client.call("project:snapshot", [project])).state;
  assert.ok(state.messages.some((message) => message.role === "assistant" && message.body === "Hello"));
  assert.equal(state.sessions[chat.id].native_session_id, "thread-1");
  client.close();
  await daemon.close();
  scenario = "slow";
  daemon = await startDaemon(options);
  client = await attach();
  const restored = await client.call("project:open", [project]);
  assert.ok(restored.state.messages.some((message) => message.body === "Hello"));
  const cancellation = [];
  client.on("event", (event) => cancellation.push(event));
  await client.call("chat:send", [{ ...request, body: "Cancel this turn" }]);
  await until(() => cancellation.find((e) => e.channel === "agent:event" && e.payload.event.type === "turn-started"));
  await client.call("agent:interrupt", [`${project}#${chat.id}`]);
  await until(() => cancellation.find((e) => e.channel === "agent:event" && e.payload.event.type === "turn-cancelled"));
  await client.call("daemon:flush");
  state = await readSavedState(project);
  assert.ok(state.messages.some((message) => message.body === "Cancel this turn"));
  assert.equal(state.sessions[chat.id].native_session_id, "thread-1");
});

test("Windows rejects a token whose NTFS ACL permits another local account", { skip: process.platform !== "win32" }, async (t) => {
  const { dataDir } = await fixture(t);
  const { execFileSync } = require("node:child_process");
  const { powershell, powershellEnvironment, windowsAcl } = require("@milagre/core/private-files");
  const encodedPath = Buffer.from(tokenPath(dataDir), "utf8").toString("base64");
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $a=Get-Acl -LiteralPath $p; $sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow); [void]$a.AddAccessRule($rule); (Get-Item -LiteralPath $p).SetAccessControl($a)`;
  execFileSync(powershell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: powershellEnvironment(),
    windowsHide: true,
  });
  try {
    assert.throws(() => readToken(dataDir), /another Windows account/);
    await assert.rejects(connect({ dataDir }), /another Windows account/);
  } finally {
    windowsAcl(tokenPath(dataDir), { mode: "protect" });
  }
});

test("mutual authentication refuses an impersonated daemon without disclosing the token", async (t) => {
  const { prepareToken } = require("./local-auth.cjs");
  const { socketPath, prepareSocketDirectory } = require("./paths.cjs");
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-impersonation-")));
  prepareToken(dataDir);
  const endpoint = socketPath(dataDir);
  prepareSocketDirectory(endpoint);
  let firstFrame;
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      firstFrame = JSON.parse(String(chunk));
      socket.write(JSON.stringify({ v: 1, id: firstFrame.id, result: { serverNonce: "1".repeat(64), proof: "2".repeat(64) } }) + "\n");
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await assert.rejects(connect({ dataDir, requireAuthentication: true }), /could not prove its identity/);
  assert.equal(firstFrame.method, "daemon:authenticate");
  assert.deepEqual(Object.keys(firstFrame.args[0]), ["clientNonce"]);
  assert.ok(!JSON.stringify(firstFrame).includes(readToken(dataDir)));
});

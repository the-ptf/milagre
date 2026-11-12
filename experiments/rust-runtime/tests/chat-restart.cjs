// Production Node wire client, Rust owner, shared configured Claude provider and fixed native child.
// No Milagre Node daemon, installed profile, credentials or real Claude process are started.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { connect } = require("../../../apps/daemon/src/client.cjs");

const executable = path.resolve(process.argv[2]);
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rust-chat-restart-"));
const dataRoot = path.join(parent, "data");
const children = new Set();

function deadline(promise, label, ms = 12000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function child(args) {
  const process = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
  const record = { process, stderr: "", stdout: "" };
  record.exit = new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code, signal) => {
      children.delete(record);
      resolve({ code, signal });
    });
  });
  process.stderr.on("data", (chunk) => {
    record.stderr = (record.stderr + chunk).slice(-65536);
  });
  process.stdout.on("data", (chunk) => {
    record.stdout = (record.stdout + chunk).slice(-65536);
  });
  children.add(record);
  return record;
}

async function refused(args) {
  const record = child(args);
  record.process.stdin.end();
  const result = await deadline(record.exit, "refused launch");
  assert.notEqual(result.code, 0, record.stderr);
  assert.equal(record.stdout, "");
  return record.stderr;
}

async function launch(mode) {
  const record = child([mode, dataRoot]);
  const lines = readline.createInterface({ input: record.process.stdout });
  const metadata = await deadline(
    Promise.race([
      new Promise((resolve) => lines.once("line", (line) => resolve(JSON.parse(line)))),
      record.exit.then(() => {
        throw Error(`Launch exited: ${record.stderr}`);
      }),
    ]),
    "runtime receipt",
  );
  lines.close();
  assert.equal(metadata.restartable, true);
  assert.equal(metadata.fakeClaude, true);
  assert.equal(metadata.dataRoot, fs.realpathSync(dataRoot));
  const client = await connect({ dataDir: metadata.profile, timeoutMs: 8000 });
  const events = [];
  const waiters = new Set();
  client.on("event", (received) => {
    events.push(received);
    for (const waiter of waiters)
      if (waiter.predicate(received)) {
        waiters.delete(waiter);
        waiter.resolve(received);
      }
  });
  function event(predicate) {
    const found = events.find(predicate);
    if (found) return Promise.resolve(found);
    let waiter;
    return deadline(
      new Promise((resolve) => {
        waiter = { predicate, resolve };
        waiters.add(waiter);
      }),
      "owner event",
    ).finally(() => waiters.delete(waiter));
  }
  const project = metadata.actor.project;
  await assert.rejects(client.call("chat:patch", [project, 1, { unread: false }]), { code: "ISOLATED_SCOPE_ONLY" });
  const opened = await client.call("project:open", [project]);
  const state = await client.call("state:read", [project]);
  assert.equal(opened.epoch, state.epoch);
  assert.equal((await client.call("project:read", [project])).epoch, state.epoch);
  assert.equal((await client.call("daemon:snapshot")).projects[0].epoch, state.epoch);
  assert.equal((await client.call("accounts:scope", [project, false])).providers.find((p) => p.provider === "claude").effectiveId, metadata.actor.accountId);
  await assert.rejects(client.call("agent:cli-status", [project]), { code: "CLI_STATUS_UNAVAILABLE" });
  for (const method of ["canvas:snapshot", "canvas:links", "link:list", "accounts:scopes"]) {
    await assert.rejects(client.call(method, [project + "/foreign"]), { code: "CHAT_RUNTIME_CONFIG" });
  }
  assert.deepEqual(await client.call("canvas:links"), []);
  assert.deepEqual(await client.call("link:list"), []);
  assert.deepEqual(await client.call("accounts:scopes"), [
    { key: project, name: "Rust Chat", kind: "project", projects: [{ id: project, path: project, name: "Rust Chat" }] },
  ]);
  const canvas = await client.call("canvas:snapshot");
  assert.deepEqual(canvas.projects, await client.call("project:registry"));
  assert.deepEqual(canvas.links, []);
  assert.deepEqual(canvas.projectGroups, []);
  assert.deepEqual(canvas.worktreePositions, {});
  assert.deepEqual(canvas.states, [{ path: project, state: (await client.call("project:read", [project])).state }]);
  return { record, metadata, client, project, events, event, epoch: state.epoch };
}

async function stop(runtime) {
  const until = Date.now() + 12000;
  for (;;) {
    try {
      await runtime.client.call("daemon:stop");
      break;
    } catch (error) {
      assert.equal(error.code, "QUIT_PENDING", "only retained cleanup permits a stop retry");
      assert.ok(Date.now() < until, "native content cleanup did not finish");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  runtime.client.close();
  runtime.record.process.stdin.end();
  const result = await deadline(runtime.record.exit, "exact runtime exit");
  assert.equal(result.code, 0, runtime.record.stderr);
  assert.equal(fs.existsSync(runtime.metadata.profile), false);
  assert.equal(fs.existsSync(runtime.metadata.socket), false);
  assert.equal(fs.existsSync(runtime.project), true);
  assert.equal(fs.existsSync(path.join(runtime.project, ".milagre/runtime.lock")), false);
}

async function turn(runtime, id, body) {
  const permission = runtime.event((e) => e.channel === "agent:event" && e.payload.event.type === "permission-request");
  const terminal = runtime.event((e) => e.channel === "agent:event" && ["turn-completed", "turn-failed", "turn-cancelled"].includes(e.payload.event.type));
  await runtime.client.call("chat:send", [
    { projectPath: runtime.project, sessionId: 1, provider: "claude", model: "sonnet", permissionMode: "ask", clientMessageId: id, body },
  ]);
  const card = (await permission).payload.event;
  assert.equal(await runtime.client.call("agent:respond-permission", [{ chatId: `${runtime.project}#1`, requestId: card.requestId, decision: "allow" }]), true);
  assert.equal((await terminal).payload.event.type, "turn-completed");
  const text = runtime.events
    .filter((e) => e.channel === "agent:event" && e.payload.event.type === "text-delta")
    .map((e) => e.payload.event.text)
    .join("");
  assert.equal(text, "Restartable Claude reply");
  const snapshot = await runtime.client.call("project:read", [runtime.project]);
  assert.deepEqual(
    (await runtime.client.call("canvas:snapshot")).states,
    [{ path: runtime.project, state: snapshot.state }],
    "canvas includes current completed owner state",
  );
  assert.equal(snapshot.state.sessions["1"].native_session_id, "restartable-native-session");
  const messages = (await runtime.client.call("chat:messages", [runtime.project, 1])).messages;
  assert.equal(messages.filter((m) => m.clientMessageId === id).length, 1);
  assert.ok(messages.some((m) => m.body === body));
  assert.ok(messages.some((m) => m.body === "Restartable Claude reply"));
  for (const event of runtime.events.filter((e) => e.channel === "project:state")) assert.equal(event.payload.epoch, runtime.epoch);
  return messages;
}

async function main() {
  // Actual shared Node reducer is the unread-patch oracle, including deletion on false and no-op identity.
  const { patchSession } = await import("../../../packages/shared/src/project-edits.mjs");
  async function unreadPatch(runtime, unread) {
    const before = await runtime.client.call("state:read", [runtime.project]);
    const expected = patchSession(before.state, 1, { unread });
    const eventsBefore = runtime.events.length;
    assert.equal(await runtime.client.call("chat:patch", [runtime.project, 1, { unread }]), null);
    const after = await runtime.client.call("state:read", [runtime.project]);
    assert.deepEqual(after.state, expected, "actual Node patchSession parity");
    const changed = expected !== before.state;
    assert.equal(after.version, before.version + Number(changed));
    const published = runtime.events.slice(eventsBefore).filter((event) => event.channel === "project:state");
    assert.equal(published.length, Number(changed), "saved read mark publishes before its RPC reply; no-op stays quiet");
    if (changed) {
      assert.equal(published[0].payload.version, after.version);
      assert.equal(published[0].payload.epoch, runtime.epoch);
    }
    assert.deepEqual((await runtime.client.call("daemon:snapshot")).projects[0].state, expected);
    const disk = JSON.parse(fs.readFileSync(path.join(runtime.project, ".milagre/coordination.json"), "utf8"));
    // Runtime-only session fields (for example suggestionTurnId) are intentionally absent from saved state.
    assert.equal(Object.hasOwn(disk.sessions["1"], "unread"), unread, "unread patch is durable before graceful stop");
    assert.equal(disk.sessions["1"].unread, expected.sessions["1"].unread);
  }
  const first = await launch("fixture-create");
  const contentChat = `${first.project}#1`;
  assert.deepEqual(await first.client.call("artifact:list", [{ chatId: contentChat }]), [], "real startup has no seeded content");
  assert.deepEqual(await first.client.call("designs:enabled:read"), { enabled: true });
  for (const chatId of [`${first.project}#999`, `${first.project}#01`, `${first.project}/foreign#1`]) {
    await assert.rejects(first.client.call("artifact:list", [{ chatId }]));
  }
  assert.match(await refused(["fixture-open", dataRoot]), /already running/);
  const manifest = fs.readFileSync(path.join(dataRoot, "rust-chat-runtime.json"));
  assert.equal(fs.statSync(path.join(dataRoot, "rust-chat-runtime.json")).mode & 0o777, 0o600);
  const body = "ordinary prompt over the old 4 KiB fixture cap\n" + "coding context\n".repeat(500);
  await assert.rejects(
    first.client.call("chat:send", [{ projectPath: first.project, sessionId: 1, provider: "claude", model: "unselected", body: "refuse" }]),
    { code: "CHAT_RUNTIME_CONFIG" },
  );
  await assert.rejects(
    first.client.call("chat:send", [{ projectPath: first.project, sessionId: 1, provider: "claude", model: "sonnet", body: "forged", chatId: "/foreign#1" }]),
    { code: "CHAT_RUNTIME_CONFIG" },
  );
  const saved = await turn(first, "first-durable-message", body);
  const catalog = await first.client.call("artifact:list", [{ chatId: contentChat }]);
  assert.deepEqual(catalog.map((record) => record.id).sort(), ["configured-report", "configured-screen"]);
  const report = await first.client.call("artifact:get", [{ chatId: contentChat, id: "configured-report" }]);
  assert.equal(report.version, 1);
  assert.match(JSON.stringify(report), /Configured native content/);
  const design = await first.client.call("artifact:get", [{ chatId: contentChat, id: "configured-screen" }]);
  assert.equal(design.version, 1);
  const stateBeforeEdit = await first.client.call("state:read", [first.project]);
  const edit = {
    chatId: contentChat,
    id: "configured-screen",
    expectedVersion: 1,
    operations: [{ op: "update", id: "heading", patch: { text: "Retained renderer edit" } }],
  };
  const edited = await first.client.call("artifact:apply", [edit]);
  assert.equal(edited.version, 2);
  assert.match(JSON.stringify(edited), /Retained renderer edit/);
  await assert.rejects(first.client.call("artifact:apply", [edit]), { code: "DESIGN_VERSION_CONFLICT" });
  assert.deepEqual(await first.client.call("state:read", [first.project]), stateBeforeEdit, "the shared content writer does not alter Chat state");
  const beforeRefusals = await first.client.call("state:read", [first.project]);
  for (const args of [
    [first.project + "/foreign", 1, { unread: false }],
    [first.project, 0, { unread: false }],
    [first.project, 1.5, { unread: false }],
    [first.project, "1", { unread: false }],
    [first.project, 999, { unread: false }],
    [first.project, 1, { unread: null }],
    [first.project, 1, { title: "unsupported" }],
    [first.project, 1, { unread: false, archived: true }],
  ])
    await assert.rejects(first.client.call("chat:patch", args));
  assert.deepEqual(await first.client.call("state:read", [first.project]), beforeRefusals);
  await unreadPatch(first, false);
  await unreadPatch(first, true);
  await unreadPatch(first, true);
  await stop(first);
  assert.deepEqual(fs.readFileSync(path.join(dataRoot, "rust-chat-runtime.json")), manifest);
  assert.equal(fs.existsSync(path.join(first.project, ".milagre/chats.db")), true);
  assert.match(await refused(["fixture-create", dataRoot]), /exist/i);
  assert.deepEqual(fs.readFileSync(path.join(dataRoot, "rust-chat-runtime.json")), manifest);

  const second = await launch("fixture-open");
  assert.deepEqual(await second.client.call("artifact:get", [{ chatId: contentChat, id: "configured-report" }]), report);
  assert.deepEqual(await second.client.call("artifact:get", [{ chatId: contentChat, id: "configured-screen", version: 1 }]), {
    ...design,
    latest: 2,
    versions: 2,
  });
  assert.deepEqual(await second.client.call("artifact:get", [{ chatId: contentChat, id: "configured-screen" }]), edited);
  assert.notEqual(second.epoch, first.epoch);
  assert.notEqual(second.metadata.profile, first.metadata.profile);
  assert.notEqual(second.metadata.socket, first.metadata.socket);
  assert.deepEqual((await second.client.call("chat:messages", [second.project, 1])).messages, saved);
  assert.equal((await second.client.call("state:read", [second.project])).state.sessions["1"].unread, true);
  assert.equal((await second.client.call("state:read", [second.project])).state.sessions["1"].native_session_id, "restartable-native-session");
  await second.client.call("chat:send", [
    { projectPath: second.project, sessionId: 1, provider: "claude", model: "sonnet", body, clientMessageId: "first-durable-message" },
  ]);
  assert.deepEqual((await second.client.call("chat:messages", [second.project, 1])).messages, saved);
  const updated = await turn(second, "second-durable-message", "Resume the saved Chat");
  assert.equal(updated.filter((m) => m.role === "user").length, 2);
  await unreadPatch(second, false);
  await unreadPatch(second, false);
  await stop(second);

  const third = await launch("fixture-open");
  assert.deepEqual(await third.client.call("artifact:get", [{ chatId: contentChat, id: "configured-screen" }]), edited);
  assert.notEqual(third.epoch, second.epoch);
  assert.deepEqual((await third.client.call("chat:messages", [third.project, 1])).messages, updated);
  assert.equal(Object.hasOwn((await third.client.call("state:read", [third.project])).state.sessions["1"], "unread"), false);
  await third.client.call("project:forget", [third.project]);
  await assert.rejects(third.client.call("artifact:list", [{ chatId: contentChat }]), { code: "PROJECT_NOT_READY" });
  await assert.rejects(third.client.call("chat:patch", [third.project, 1, { unread: true }]), { code: "PROJECT_NOT_READY" });
  await third.client.call("project:open", [third.project]);
  assert.deepEqual(await third.client.call("artifact:get", [{ chatId: contentChat, id: "configured-screen" }]), edited);
  await stop(third);

  const unmarked = path.join(parent, "unmarked");
  fs.mkdirSync(unmarked);
  fs.writeFileSync(path.join(unmarked, "sentinel"), "keep");
  await refused(["fixture-open", unmarked]);
  await refused(["fixture-create", unmarked]);
  assert.deepEqual(fs.readdirSync(unmarked), ["sentinel"]);
  assert.equal(fs.readFileSync(path.join(unmarked, "sentinel"), "utf8"), "keep");
  console.log(
    "Restartable Chat: three launches, saved/native ID continuity, permission turn, durable unread/Node parity, shared MCP Artifact/Design create/read, renderer edit/restart history, scope/patch/root refusals and native cleanup passed (fixed child only).",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const record of children) record.process.stdin.end();
    await Promise.all(
      [...children].map(async (record) => {
        try {
          await deadline(record.exit, "cleanup", 12000);
        } catch {
          record.process.kill("SIGKILL");
          await record.exit;
        }
      }),
    );
    fs.rmSync(parent, { recursive: true });
  });

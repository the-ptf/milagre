const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { CodexRpc } = require("./codex-rpc.cjs");
const { waitUntil } = require("./test-helpers.cjs");

const FAKE = path.join(__dirname, "fixtures", "fake-app-server.cjs");

function client(t, scenario = "reply", command = process.execPath) {
  const rpc = new CodexRpc({ command, args: [FAKE], env: { ...process.env, FAKE_SCENARIO: scenario } });
  rpc.start();
  t.after(() => rpc.close());
  return rpc;
}

test("matches responses to requests and emits notifications in order", async (t) => {
  const rpc = client(t);
  const methods = [];
  rpc.on("notification", ({ method }) => methods.push(method));

  assert.deepEqual(await rpc.request("initialize", {}), { userAgent: "fake/0.158.0" });
  const { thread } = await rpc.request("thread/start", { model: "gpt-6-sol" });
  const { turn } = await rpc.request("turn/start", { threadId: thread.id, input: [] });

  assert.equal(turn.id, "turn-1");
  await waitUntil(() => methods.includes("turn/completed"));
  assert.deepEqual(methods, ["turn/started", "mcpServer/startupStatus/updated", "item/agentMessage/delta", "item/agentMessage/delta", "turn/completed"]);
});

test("rejects with the server's error message", async (t) => {
  const rpc = client(t);
  await assert.rejects(rpc.request("thread/nope"), /unknown method thread\/nope/);
});

test("marks server error responses but not exits", async (t) => {
  const rpc = client(t);
  const error = await rpc.request("thread/nope").catch((caught) => caught);
  assert.equal(error.rpcError.code, -32601);

  const missing = client(t, "reply", "milagre-definitely-missing-cli");
  const exit = await missing.request("initialize", {}).catch((caught) => caught);
  assert.equal(exit.rpcError, undefined);
});

test("delivers server requests and sends the reply back", async (t) => {
  const rpc = client(t, "approval");
  const deltas = [];
  rpc.on("request", ({ id, method }) => {
    assert.equal(method, "item/commandExecution/requestApproval");
    rpc.respond(id, { decision: "decline" });
  });
  rpc.on("notification", ({ method, params }) => {
    if (method === "item/agentMessage/delta") deltas.push(params.delta);
  });

  const { thread } = await rpc.request("thread/start", {});
  await rpc.request("turn/start", { threadId: thread.id, input: [] });

  await waitUntil(() => deltas.length > 0);
  assert.deepEqual(deltas, ["decision:decline"]);
});

test("reports Codex's stderr when the process exits and rejects later requests", async (t) => {
  const rpc = client(t, "crash");
  const exits = [];
  rpc.on("exit", (exit) => exits.push(exit));

  const { thread } = await rpc.request("thread/start", {});
  await rpc.request("turn/start", { threadId: thread.id, input: [] });

  await waitUntil(() => exits.length === 1);
  assert.match(exits[0].detail, /boom: model unavailable/);
  await assert.rejects(rpc.request("initialize", {}), /not running/);
});

test("a request without a time limit waits until Codex answers or exits", async (t) => {
  const rpc = client(t, "hang-thread");
  await rpc.request("initialize", {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const started = rpc.request("thread/start", {}, { timeoutMs: null }).finally(() => (settled = true));
  started.catch(() => {});
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  // Real timers again before any assertion, so closing the client can't stall on a mocked one.
  t.mock.timers.reset();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  const failed = assert.rejects(started, /Codex exited/);
  await rpc.close();
  await failed;
});

test("explains a CLI that can't be started", async (t) => {
  const rpc = client(t, "reply", "milagre-definitely-missing-cli");
  const exits = [];
  rpc.on("exit", (exit) => exits.push(exit));

  await assert.rejects(rpc.request("initialize", {}), /isn't installed or isn't on your PATH/);
  assert.match(exits[0].detail, /milagre-definitely-missing-cli isn't installed or isn't on your PATH/);
});

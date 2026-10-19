const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { AcpRpc } = require("./acp-rpc.cjs");
const { queryAntigravityModels } = require("./antigravity-model-list.cjs");

const FAKE = path.join(__dirname, "fixtures", "fake-acp-agent.cjs");

test("model discovery reads ACP session options without sending a prompt or authenticating, then cleans up", async () => {
  const sent = [];
  let spawned, rpc;
  const result = await queryAntigravityModels({
    command: "/agent/agy_acp_server.par",
    clientVersion: "test",
    createRpc(options) {
      spawned = options;
      rpc = new AcpRpc({ ...options, command: process.execPath, args: [FAKE] });
      const request = rpc.request.bind(rpc);
      rpc.request = (method, params, timeout) => {
        sent.push({ method, params });
        return request(method, params, timeout);
      };
      return rpc;
    },
  });
  assert.deepEqual(
    result.offered.map((model) => model.value),
    ["gemini-3.8-flash-high", "flash-lite-agent", "gemini-pro-agent"],
  );
  assert.equal(result.current, "gemini-3.8-flash-high");
  assert.deepEqual(
    sent.map((message) => message.method),
    ["initialize", "session/new"],
  );
  assert.deepEqual(sent[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.deepEqual(sent[1].params, { cwd: spawned.cwd, mcpServers: [] });
  assert.equal(spawned.env.TMPDIR, spawned.cwd);
  assert.equal(fs.existsSync(spawned.cwd), false);
  assert.equal(rpc.exited, true);
});

test("a stalled model agent is killed at the discovery deadline and its extraction directory is removed", async () => {
  let spawned, rpc;
  await assert.rejects(
    queryAntigravityModels({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 50,
      createRpc(options) {
        spawned = options;
        rpc = new AcpRpc(options);
        return rpc;
      },
    }),
    { timedOut: true },
  );
  assert.equal(fs.existsSync(spawned.cwd), false);
  assert.equal(rpc.exited, true);
});

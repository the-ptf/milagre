// Actual dedicated-root CLI and production Node wire client, synthetic native Codex child only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const executable = path.resolve(process.argv[2]);
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rust-codex-entry-"));
const root = path.join(parent, "data");
const active = new Set();
let completed = false;
const limit = (promise, label, ms = 12000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(Error(label)), ms)))]).finally(() => clearTimeout(timer));
};
async function launch(create) {
  const process = spawn(executable, create ? ["create", root, path.join(parent, "launch.json")] : ["open", root], { stdio: ["pipe", "pipe", "pipe"] });
  active.add(process);
  let stderr = "";
  process.stderr.on("data", (b) => (stderr += b));
  const exit = new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code, signal) => {
      active.delete(process);
      resolve({ code, signal });
    });
  });
  const lines = readline.createInterface({ input: process.stdout });
  const receipt = await limit(
    Promise.race([
      new Promise((resolve) => lines.once("line", (line) => resolve(JSON.parse(line)))),
      exit.then(() => {
        throw Error(stderr);
      }),
    ]),
    "receipt",
  );
  lines.close();
  assert.equal(receipt.actor.provider, "codex");
  assert.equal(receipt.fakeClaude, false);
  const client = await connect({ dataDir: receipt.profile, timeoutMs: 8000 });
  const project = receipt.actor.project;
  await client.call("project:open", [project]);
  const models = await client.call("agent:models", [project]);
  assert.deepEqual(Object.keys(models), ["codex"]);
  assert.equal(models.codex[0].id, "fixture-model");
  assert.equal(models.codex[0].fastMode, false);
  assert.equal((await client.call("accounts:scope", [project, false])).providers[0].provider, "codex");
  return { process, exit, receipt, client, project, stderr: () => stderr };
}
async function stop(r) {
  for (const end = Date.now() + 12000; ;) {
    try {
      await r.client.call("daemon:stop");
      break;
    } catch (e) {
      assert.equal(e.code, "QUIT_PENDING");
      assert.ok(Date.now() < end);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  r.client.close();
  r.process.stdin.end();
  assert.deepEqual(await limit(r.exit, "stop"), { code: 0, signal: null }, r.stderr());
  assert.equal(r.stderr(), "");
  assert.equal(fs.existsSync(r.receipt.profile), false);
  assert.equal(fs.existsSync(r.receipt.socket), false);
  assert.equal(fs.existsSync(path.join(r.project, ".milagre/runtime.lock")), false);
  assert.equal(fs.existsSync(root), true);
}
async function main() {
  fs.mkdirSync(path.join(parent, "home"), { mode: 0o700 });
  fs.mkdirSync(path.join(parent, "account"), { mode: 0o700 });
  const fake = path.resolve("../../packages/core/src/agents/fixtures/fake-app-server.cjs");
  const probe = path.join(parent, "probe.cjs");
  const frames = path.join(parent, "native-threads.jsonl");
  fs.writeFileSync(
    probe,
    `const fs=require('fs');let buf='';process.stdin.on('data',chunk=>{buf+=chunk;let n;while((n=buf.indexOf('\\n'))>=0){const raw=buf.slice(0,n);buf=buf.slice(n+1);if(!raw)continue;const frame=JSON.parse(raw);if(['thread/start','thread/resume','turn/start'].includes(frame.method))fs.appendFileSync(${JSON.stringify(frames)},JSON.stringify({method:frame.method,params:frame.params})+'\\n');}});`,
    { mode: 0o600 },
  );
  const program = path.join(parent, "codex");
  fs.writeFileSync(program, `#!/bin/sh\n[ "$1" = app-server ] || exit 92\nexec '${process.execPath}' --require '${probe}' '${fake}' "$@"\n`, { mode: 0o700 });
  const manifest = {
    provider: "codex",
    program,
    home: path.join(parent, "home"),
    configDirectory: path.join(parent, "account"),
    skillsDirectory: path.resolve("../../packages/core/src/bundled-skills"),
    model: "fixture-model",
    path: "/usr/bin:/bin",
    accountId: "11111111-1111-4111-8111-111111111111",
    accountLabel: "Synthetic Codex account",
    userName: "synthetic-codex-user",
  };
  fs.writeFileSync(path.join(parent, "launch.json"), JSON.stringify(manifest), { mode: 0o600 });
  const first = await launch(true);
  const events = [];
  let ended;
  const terminal = limit(new Promise((resolve) => (ended = resolve)), "terminal");
  first.client.on("event", (event) => {
    events.push(event);
    if (event.channel === "agent:event" && ["turn-completed", "turn-failed", "turn-cancelled"].includes(event.payload.event.type)) ended(event.payload.event);
  });
  await assert.rejects(
    first.client.call("chat:send", [{ projectPath: first.project, sessionId: 1, provider: "claude", model: "fixture-model", body: "refuse" }]),
    { code: "CHAT_RUNTIME_CONFIG" },
  );
  await first.client.call("chat:send", [
    {
      projectPath: first.project,
      sessionId: 1,
      provider: "codex",
      model: "fixture-model",
      body: "Dedicated Codex entrypoint",
      prompt: "Dedicated Codex entrypoint",
      worktreeId: 1,
      images: [],
      files: [],
      effort: null,
      ultracode: false,
      fastMode: false,
      replies: "concise",
      clientMessageId: "codex-entry-1",
      permissionMode: "ask",
      tldrEnabled: true,
    },
  ]);
  assert.equal((await terminal).type, "turn-completed");
  assert.equal(
    events
      .filter((e) => e.channel === "agent:event" && e.payload.event.type === "text-delta")
      .map((e) => e.payload.event.text)
      .join(""),
    "Hello",
  );
  const transcript = await first.client.call("chat:messages", [first.project, 1]);
  assert.equal(transcript.messages.length, 2);
  assert.equal(transcript.messages[0].body, "Dedicated Codex entrypoint");
  assert.equal(transcript.messages[1].body, "Hello");
  const state = await first.client.call("project:read", [first.project]);
  assert.equal(typeof state.state.sessions["1"].native_session_id, "string");
  await stop(first);
  const second = await launch(false);
  assert.notEqual(first.receipt.pid, second.receipt.pid);
  assert.deepEqual(await second.client.call("chat:messages", [second.project, 1]), transcript);
  const secondEvents = [];
  let secondEnd;
  const resumed = limit(new Promise((resolve) => (secondEnd = resolve)), "resumed terminal");
  second.client.on("event", (event) => {
    secondEvents.push(event);
    if (event.channel === "agent:event" && ["turn-completed", "turn-failed", "turn-cancelled"].includes(event.payload.event.type))
      secondEnd(event.payload.event);
  });
  await second.client.call("chat:send", [
    {
      projectPath: second.project,
      sessionId: 1,
      provider: "codex",
      model: "fixture-model",
      body: "Resume dedicated Codex context",
      prompt: "Resume dedicated Codex context",
      worktreeId: 1,
      images: [],
      files: [],
      effort: "high",
      ultracode: false,
      fastMode: false,
      replies: "normal",
      clientMessageId: "codex-entry-2",
      permissionMode: "ask",
      tldrEnabled: true,
    },
  ]);
  assert.equal((await resumed).type, "turn-completed");
  assert.equal((await second.client.call("chat:messages", [second.project, 1])).messages.length, 4);
  const recorded = fs.readFileSync(frames, "utf8").trim().split("\n").map(JSON.parse);
  const threads = recorded.filter((frame) => frame.method !== "turn/start");
  assert.deepEqual(
    threads.map((frame) => frame.method),
    ["thread/start", "thread/resume"],
  );
  assert.equal(threads[1].params.threadId, state.state.sessions["1"].native_session_id);
  assert.equal(threads[0].params.developerInstructions, threads[1].params.developerInstructions);
  const { sessionInstructions } = require("../../../packages/core/src/agents/events.cjs");
  assert.equal(threads[0].params.developerInstructions, sessionInstructions({ tldrEnabled: true }));
  // Call the real Node implementation, not a duplicated request builder. React's
  // provider-independent reply preference is deliberately absent from native Codex.
  const { CodexSession } = require("../../../packages/core/src/agents/codex-provider.cjs");
  async function nodeTurn(prompt, effort, replies, threadId) {
    let native;
    const session = {
      cwd: first.project,
      access: { roots: [], learned() {} },
      permissions: { setMode() {} },
      state: { threadId, turnId: null },
      starting: Promise.resolve(),
      rpc: {
        async request(method, params) {
          assert.equal(method, "turn/start");
          native = params;
          return { turn: { id: "oracle-turn" } };
        },
      },
    };
    const result = await CodexSession.prototype.beginTurn.call(session, {
      prompt,
      model: "fixture-model",
      permissionMode: "ask",
      images: [],
      effort,
      replies,
      tldrEnabled: true,
      ultracode: false,
      fastMode: false,
    });
    assert.equal(result.turnId, "oracle-turn");
    return native;
  }
  const turns = recorded.filter((frame) => frame.method === "turn/start");
  assert.equal(turns.length, 2);
  for (const [index, prompt, effort] of [
    [0, "Dedicated Codex entrypoint", null],
    [1, "Resume dedicated Codex context", "high"],
  ]) {
    const expected = await nodeTurn(prompt, effort, "concise", turns[index].params.threadId);
    for (const replies of ["normal", null, undefined]) {
      assert.deepEqual(await nodeTurn(prompt, effort, replies, turns[index].params.threadId), expected);
    }
    assert.deepEqual(turns[index].params, expected);
  }
  await stop(second);
  completed = true;
  console.log(JSON.stringify({ passed: true, provider: "codex", turns: 2, reopenedWithoutSend: true, nativeResume: true, cleanup: true }));
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const process of active) {
      process.stdin.end();
    }
    if (completed) fs.rmSync(parent, { recursive: true, force: true });
    else console.error(`Evidence retained: ${parent}`);
  });

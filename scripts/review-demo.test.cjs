const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { startReviewDemo, announce, DEFAULT_DATA_DIR, PROJECT_NAME, LINK_FILE, PHONE_PORT, COMPUTER_NAME } = require("./review-demo.cjs");
const { demoSession, DEMO_MODEL } = require("../apps/daemon/src/demo-agent.cjs");
const { REFUSED } = require("../apps/daemon/src/confine.cjs");

// The relay is replaced: the test checks what the demo asks of it, and talks to the bridge directly.
function fakeRelay() {
  const started = [];
  const startRelay = (options) => {
    started.push(options);
    return { status: () => "online", close: async () => {} };
  };
  return { started, startRelay };
}

test("the review demo seeds a project, runs only the demo agent, and confines the phone to that project", async (t) => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-review-demo-")));
  // A data dir that does not exist yet, with a space in its name like the default.
  const dataDir = path.join(parent, "Milagre Review Demo");
  const relay = fakeRelay();
  const logs = [];
  let demo;
  t.after(async () => {
    await demo?.close();
    await fs.rm(parent, { recursive: true, force: true });
  });
  demo = await startReviewDemo({ dataDir, phoneOptions: { startRelay: relay.startRelay, localPort: 0 }, keepOpenMs: 50, log: (line) => logs.push(line) });
  const project = path.join(dataDir, PROJECT_NAME);
  assert.equal(demo.project, project);
  assert.equal(PHONE_PORT, 8899);
  assert.equal(DEFAULT_DATA_DIR, "/Users/Shared/Milagre Review Demo", "project paths never show the owner's home");
  assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o700);
  assert.equal(demo.runtimeOptions.expandSkills, false);
  await assert.rejects(demo.runtimeOptions.readPullRequest(project), /not available on the demo computer/);

  // Only the demo agent: no other session factory, no CLI, no account usage, and only its model.
  assert.notEqual(demo.runtimeOptions.createSession, undefined);
  assert.equal(demo.runtimeOptions.createSession.name, demoSession.name);
  assert.match((await demo.runtimeOptions.agentCli("claude")).command, /^\/nonexistent\//);
  assert.match((await demo.runtimeOptions.agentCli("codex")).command, /^\/nonexistent\//);
  assert.deepEqual(await demo.client.call("agent:models"), { codex: [DEMO_MODEL], claude: null, antigravity: null, kiro: null });
  assert.equal((await demo.client.call("agent:cli-status")).claude.state, "missing");
  assert.deepEqual(await demo.client.call("usage:read"), { providers: [] });

  // A Git project with files, an uncommitted change and two Chats with replies.
  assert.match(await fs.readFile(path.join(project, "src", "greeting.js"), "utf8"), /excited/);
  const opened = await demo.client.call("project:snapshot", [project]);
  const titled = Object.values(opened.state.sessions).filter((session) => session.title);
  assert.deepEqual(titled.map((session) => session.title).sort(), ["Check the tests", "Welcome to Milagre"]);
  for (const session of titled)
    assert.ok(
      opened.state.messages.some((message) => message.session_id === session.id && message.role !== "user" && message.body),
      session.title,
    );

  // The phone pairs through the relay with the demo's name, on its own port, and the link is saved privately.
  const status = await demo.client.call("phone:status");
  assert.equal(status.state, "on");
  assert.equal(status.remote, "relay");
  assert.equal(relay.started.length, 1);
  assert.equal(new URL(demo.link).searchParams.get("name"), COMPUTER_NAME);
  assert.match(demo.link, /^milagre:\/\/pair\?relay=wss%3A%2F%2Frelay\.milagre\.cloud&host=/);
  const linkFile = path.join(dataDir, LINK_FILE);
  assert.equal(demo.linkFile, linkFile);
  assert.equal(await fs.readFile(linkFile, "utf8"), `${demo.link}\n`);
  assert.equal((await fs.stat(linkFile)).mode & 0o777, 0o600);

  // The pairing window keeps opening again.
  const first = status.pairingUntil;
  await delay(150);
  assert.ok((await demo.client.call("phone:status")).pairingUntil > first);

  // What a paired phone reaches: the bridge behind the relay, confined to the project.
  const token = JSON.parse(await fs.readFile(path.join(dataDir, "mobile.json"), "utf8")).token;
  const rpc = async (method, args = []) => {
    const response = await fetch(`${status.localUrl}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ v: 1, method, args }),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(
    (await rpc("project:recent")).body.result.map((entry) => entry.path),
    [project],
  );
  const daemonStatus = (await rpc("daemon:status")).body.result;
  assert.equal(JSON.stringify(daemonStatus).includes(dataDir), false, "daemon:status names no Mac path");
  assert.deepEqual(await rpc("project:open", [__dirname]), { status: 403, body: { v: 1, error: { message: REFUSED } } });
  assert.deepEqual(await rpc("project:open", [`${project}/..`]), { status: 403, body: { v: 1, error: { message: REFUSED } } });
  assert.equal((await rpc("project:open", [project])).status, 200);

  // A message to a Chat, with Claude picked, is answered by the demo agent.
  const chat = titled[0];
  assert.equal(
    (await rpc("chat:send", [{ projectPath: project, sessionId: chat.id, body: "hello", provider: "claude", model: "claude-opus-5-5", permissionMode: "ask" }]))
      .status,
    200,
  );
  const chatId = `${project}#${chat.id}`;
  for (let i = 0; ; i++) {
    const runs = (await rpc("chat:runs")).body.result.runs;
    const state = await demo.client.call("project:snapshot", [project]);
    if (!runs[chatId] && state.state.messages.at(-1).body.includes("scripted agent")) break;
    assert.ok(i < 200, "the demo agent answered");
    await delay(20);
  }

  // A restart keeps the project, its Chats and the same pairing link, and seeds nothing again.
  const messages = (await demo.client.call("project:snapshot", [project])).state.messages.length;
  await demo.close();
  logs.length = 0;
  demo = await startReviewDemo({ dataDir, phoneOptions: { startRelay: relay.startRelay, localPort: 0 }, log: (line) => logs.push(line) });
  assert.equal(demo.link, (await fs.readFile(linkFile, "utf8")).trim());
  assert.equal(new URL(demo.link).searchParams.get("token"), token);
  assert.equal((await demo.client.call("project:snapshot", [project])).state.messages.length, messages);
  assert.deepEqual(logs, []);
});

test("the start message names the link file, never the link; the QR only shows in a terminal", async () => {
  const demo = { dataDir: "/data", project: "/data/p", linkFile: "/data/review-pairing-link.txt", link: `milagre://pair?token=${"a".repeat(64)}` };
  const logged = [];
  let rendered = 0;
  const renderQr = (text, done) => {
    rendered++;
    done(`QR(${text})`);
  };
  await announce(demo, { log: (line) => logged.push(line), isTTY: false, renderQr });
  assert.equal(rendered, 0);
  assert.match(logged.join("\n"), /review-pairing-link\.txt/);
  assert.doesNotMatch(logged.join("\n"), /token=/);
  logged.length = 0;
  await announce(demo, { log: (line) => logged.push(line), isTTY: true, renderQr });
  assert.equal(rendered, 1);
});

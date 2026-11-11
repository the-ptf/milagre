// Production Node clients against a Rust owner and checked-in native fake Claude only.
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");
const readline = require("node:readline");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const { connectDesktopRuntime } = require("../../../apps/daemon/src/runtime-client.cjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, test) {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    if (await test()) return;
    await delay(10);
  }
  throw Error("Timed out: " + label);
}
async function scenario(name) {
  const child = spawn(process.argv[2], [name], { stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "exit");
  const lines = readline.createInterface({ input: child.stdout });
  const reports = [];
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.designFeedback) reports.push(value.designFeedback);
  });
  let stderr = "",
    client,
    runtime,
    metadata;
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
  try {
    metadata = JSON.parse((await once(lines, "line"))[0]);
    assert.equal(metadata.fakeClaude, true);
    assert.equal(metadata.actor.provider, "claude");
    client = await connect({ dataDir: metadata.profile, timeoutMs: 5000 });
    runtime = await connectDesktopRuntime({ connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }) });
    const project = metadata.actor.project;
    const events = [];
    client.on("event", (event) => {
      if (event.channel === "agent:event") events.push(event.payload.event);
    });
    if (name === "live-modes") {
      await assert.rejects(client.call("agent:set-permission-mode", [{ chatId: project + "#1", mode: "full" }]), { code: "ISOLATED_SCOPE_ONLY" });
    }
    await client.call("project:open", [project]);
    await runtime.openProject(project);
    const chatId = project + "#1";
    if (name === "ordinary") await ordinary({ client, events, project, child });
    else if (name === "modes") await modes({ client, events, project, child });
    else if (name === "live-modes") await liveModes({ client, events, project });
    else {
      const body = name === "unicode" ? "native \u{10fffe} \ue123 \ud83d" : "fixture input";
      await client.call("chat:send", [
        { projectPath: project, sessionId: 1, body, clientMessageId: "claude-" + name, provider: "claude", model: "sonnet", permissionMode: "ask" },
      ]);
      if (name === "queue") {
        const queued = await client.call("chat:send", [
          {
            projectPath: project,
            sessionId: 1,
            body: "second queued input",
            clientMessageId: "queued-two",
            provider: "claude",
            model: "sonnet",
            permissionMode: "ask",
            delivery: "queue",
          },
        ]);
        assert.equal(queued.sessionId, 1);
        const pendingState = await client.call("project:snapshot", [project]);
        assert.equal(pendingState.state.sessions["1"].queued.length, 1);
        assert.equal(pendingState.state.sessions["1"].queued[0].body, "second queued input");
        fs.writeFileSync(path.join(path.dirname(project), "queue-release"), "release", { flag: "wx", mode: 0o600 });
      }
      if (["permission", "content-allow", "content-deny"].includes(name)) {
        await until("permission card", () => events.some((e) => e.type === "permission-request"));
        const card = events.find((e) => e.type === "permission-request");
        assert.equal(
          await client.call("agent:respond-permission", [{ chatId, requestId: card.requestId, decision: name === "content-deny" ? "deny" : "allow" }]),
          true,
        );
      }
      if (["question", "unicode"].includes(name)) {
        await until("question card", () => events.some((e) => e.type === "question-request"));
        const card = events.find((e) => e.type === "question-request");
        assert.equal(
          await client.call("agent:answer-question", [
            { chatId, requestId: card.requestId, answers: { [card.questions[0].id]: [name === "unicode" ? body : "A"] } },
          ]),
          true,
        );
      }
      if (name === "stop") {
        await until("native session", () => events.some((e) => e.type === "session-started"));
        await client.call("agent:interrupt", [chatId]);
      }
      const expectedTurns = name === "queue" ? 2 : 1;
      await until("terminal events", () => events.filter((e) => ["turn-completed", "turn-failed", "turn-cancelled"].includes(e.type)).length === expectedTurns);
      assert.equal(events.filter((e) => ["turn-completed", "turn-failed", "turn-cancelled"].includes(e.type)).length, expectedTurns);
      if (!["stop", "crash"].includes(name)) {
        const messages = await client.call("chat:messages", [project, 1]);
        assert.ok(messages.messages.some((m) => m.body === (name === "unicode" ? "native \u{10fffe} \ue123 \ufffd" : "Claude fixture hello")));
        assert.ok(messages.messages.some((m) => m.body === body));
        if (name === "queue") {
          assert.equal(messages.messages.filter((m) => m.body === "second queued input").length, 1);
          assert.equal(messages.messages.filter((m) => m.body === "Claude fixture hello").length, 2);
          assert.equal(events.filter((e) => e.type === "session-started").length, 1, "queue reuses the same native session");
        }
      }
      if (name === "design") {
        const page = await runtime.invoke("artifact:get", [{ chatId, id: "native-screen", format: "design" }]);
        assert.equal(page.version, 2);
        assert.equal(page.document.nodes.find((node) => node.id === "paint").fill, "#0000ff");
        const changed = await runtime.invoke("artifact:apply", [
          { chatId, id: "native-screen", expectedVersion: 2, operations: [{ op: "update", id: "paint", patch: { fill: "#00ff00" } }] },
        ]);
        assert.equal(changed.version, 3);
        const latest = await runtime.invoke("artifact:get", [{ chatId, id: "native-screen", format: "design" }]);
        assert.equal(latest.document.nodes.find((node) => node.id === "paint").fill, "#00ff00");
        const saved = await client.call("chat:messages", [project, 1, { withDetails: true }]);
        const steps = saved.messages.flatMap((message) => message.steps || []);
        for (const tool of ["design_show", "design_apply"]) {
          const step = steps.find((candidate) => candidate.tool === tool);
          assert.ok(step, JSON.stringify(saved));
          assert.equal(step.kind, "artifact");
          assert.equal(step.artifact.id, "native-screen");
        }
        assert.ok(!steps.some((step) => step.kind === "image"), "MCP PNG is model feedback; image persistence is not wired");
      }
      if (["content-allow", "content-deny"].includes(name)) {
        const artifacts = await runtime.invoke("artifact:list", [{ chatId }]);
        assert.equal(artifacts.length, name === "content-deny" ? 0 : 1, JSON.stringify(artifacts));
        if (name === "content-allow") {
          const page = await runtime.invoke("artifact:get", [{ chatId, id: artifacts[0].id }]);
          assert.equal(page.version, 1);
          assert.ok(JSON.stringify(page).includes("Native shared content"));
        }
        assert.equal(events.filter((event) => event.type === "permission-request").length, 1);
        assert.equal(events.filter((event) => event.type === "turn-completed").length, 1);
      }
      if (name === "content") {
        const listed = await runtime.invoke("artifact:list", [{ chatId }]);
        assert.equal(listed.length, 1);
        const page = await runtime.invoke("artifact:get", [{ chatId, id: listed[0].id }]);
        assert.ok(JSON.stringify(page).includes("Native shared content"));
        assert.deepEqual(await runtime.invoke("artifact:list", [{ chatId: project + "#2" }]), []);
        await assert.rejects(runtime.invoke("artifact:list", [{ chatId: project + "#999" }]));
        const nativePid = () => Number(execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim());
        const beforeForget = nativePid();
        assert.ok(Number.isSafeInteger(beforeForget) && beforeForget > 1);
        await client.call("project:forget", [project]);
        await assert.rejects(runtime.invoke("artifact:list", [{ chatId }]));
        await client.call("project:open", [project]);
        await runtime.openProject(project);
        await client.call("chat:send", [
          {
            projectPath: project,
            sessionId: 1,
            body: "after reopen",
            clientMessageId: "content-reopen",
            provider: "claude",
            model: "sonnet",
            permissionMode: "ask",
          },
        ]);
        await until("fresh native content session after reopen", () => events.filter((event) => event.type === "turn-completed").length === 2);
        await until("old native process reaped", () => {
          try {
            process.kill(beforeForget, 0);
            return false;
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
            return true;
          }
        });
        const afterReopen = nativePid();
        assert.ok(Number.isSafeInteger(afterReopen) && afterReopen > 1);
        assert.notEqual(afterReopen, beforeForget, "reopen creates a new native process and registration");
        const reopened = await runtime.invoke("artifact:list", [{ chatId }]);
        const latest = await runtime.invoke("artifact:get", [{ chatId, id: reopened[0].id }]);
        assert.equal(latest.version, 2, "new native MCP registration writes after reopen");
      }
    }
    assert.equal((await client.call("daemon:snapshot")).runs.runs[chatId], undefined);
    await client.call("daemon:stop");
  } finally {
    await runtime?.close().catch((e) => {
      if (!["DAEMON_CLOSED", "CLOSING"].includes(e.code)) throw e;
    });
    client?.close();
    child.stdin.end();
    const [code] = await exit;
    clearTimeout(timeout);
    lines.close();
    assert.equal(code, 0, name + ": " + stderr);
    assert.equal(fs.existsSync(metadata.profile), false);
    assert.equal(fs.existsSync(metadata.actor.project), false);
    if (name === "design") {
      await until("actual MCP PNG feedback", () => reports.length === 1);
      assert.equal(reports[0].length, 2);
      const expected = [
        [255, 0, 0, 255],
        [0, 0, 255, 255],
      ];
      for (let i = 0; i < 2; i++) {
        const feedback = reports[0][i];
        assert.equal(feedback.isError, false);
        const image = feedback.content.find((block) => block.type === "image");
        assert.equal(image.mimeType, "image/png");
        const png = PNG.sync.read(Buffer.from(image.data, "base64"));
        assert.equal(png.width, 240);
        assert.equal(png.height, 240);
        assert.deepEqual([...png.data.subarray((120 * 240 + 120) * 4, (120 * 240 + 120) * 4 + 4)], expected[i]);
        const saved = JSON.parse(feedback.content[0].text.split("\n")[0]);
        assert.equal(saved.version, i + 1);
      }
    }
  }
}
// One active turn changes Ask -> Full -> Ask, followed by idle Auto -> Ask on the same session.
// The fixed native child checks actual Node controls and answers; receipts must arrive after owner publication.
async function liveModes({ client, events, project }) {
  const trace = require("../../rust-claude/tests/fixtures/conformance/claude-live-modes.json");
  const chatId = project + "#1";
  const change = (mode, target = chatId) => client.call("agent:set-permission-mode", [{ chatId: target, mode }]);
  const state = async () => (await client.call("project:snapshot", [project])).state;
  await assert.rejects(change("full", project + "/foreign#1"), {
    code: "ISOLATED_SCOPE_ONLY",
  });
  for (const mode of ["yolo", 1, null, {}, true]) await assert.rejects(change(mode));
  assert.equal((await state()).sessions[1].permissionMode, undefined);
  assert.equal(await change("full", project + "#2"), null, "idle Chat without provider still saves preference");
  assert.equal((await state()).sessions[2].permissionMode, "full");
  assert.equal(await change("ask", project + "#999"), null);
  assert.equal((await state()).sessions[999], undefined, "no missing Chat is created");
  const { cwd: _cwd, chatId: _chatId, ...settings } = trace.request;
  const { prompt, ...turn } = trace.turn;
  await client.call("chat:send", [
    {
      ...settings,
      ...turn,
      projectPath: project,
      sessionId: 1,
      body: prompt,
      clientMessageId: "live-modes-1",
    },
  ]);
  await until("first live permission", () => events.some((e) => e.type === "permission-request" && e.requestId === "live-0"));
  assert.equal(await change("full"), null, "no pending-mode receipt escapes the wire");
  assert.equal((await state()).sessions[1].permissionMode, "full", "success follows preference publication");
  await until("Full resolves waiting card", () => events.some((e) => e.type === "permission-resolved" && e.requestId === "live-0"));
  assert.equal(events.filter((e) => e.type === "turn-completed").length, 0, "mode change keeps the current turn running");
  assert.equal(await change("ask"), null);
  assert.equal((await state()).sessions[1].permissionMode, "ask");
  await until("downgrade requires second card", () => events.some((e) => e.type === "permission-request" && e.requestId === "live-1"));
  assert.equal(await client.call("agent:respond-permission", [{ chatId, requestId: "live-1", decision: "deny" }]), true);
  await until("live turn completed", () => events.some((e) => e.type === "turn-completed"));
  for (const mode of ["auto", "ask"]) {
    assert.equal(await change(mode), null, "retained idle session takes mode changes");
    assert.equal((await state()).sessions[1].permissionMode, mode);
  }
  assert.deepEqual(
    events.filter((e) => ["permission-request", "permission-resolved"].includes(e.type)),
    trace.cards,
  );
  assert.deepEqual(
    events.filter((e) => ["turn-started", "session-started", "turn-completed", "turn-failed", "turn-cancelled"].includes(e.type)).map((e) => e.type),
    trace.events,
  );
  const messages = await client.call("chat:messages", [project, 1]);
  assert.equal(messages.messages.filter((m) => m.body === prompt).length, 1);
  assert.equal(messages.messages.filter((m) => m.body === "Claude fixture hello").length, 1);
}
// Full, Auto and Ask sends in the composer's shape. The fake child asserts Node's launch mode, mode-switch order and
// each can_use_tool answer; this answers the Auto and Ask cards through the production client.
async function modes({ client, events, project, child }) {
  const trace = require("../../rust-claude/tests/fixtures/conformance/claude-modes.json");
  const chatId = project + "#1";
  const terminals = () => events.filter((e) => ["turn-completed", "turn-failed", "turn-cancelled"].includes(e.type));
  const nativePids = () =>
    execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map(Number);
  const answers = { full: null, auto: "allow", ask: "deny" };
  const pids = [];
  for (const [index, turn] of trace.turns.entries()) {
    await client.call("chat:send", [
      {
        projectPath: project,
        clientMessageId: "modes-" + index,
        sessionId: 1,
        worktreeId: 1,
        body: turn.prompt,
        images: [],
        files: [],
        prompt: turn.prompt,
        provider: "claude",
        model: trace.request.model,
        permissionMode: turn.permissionMode,
        effort: turn.effort,
        ultracode: false,
        fastMode: false,
        replies: trace.request.replies,
        tldrEnabled: true,
      },
    ]);
    const decision = answers[turn.permissionMode];
    if (decision) {
      const before = events.filter((e) => e.type === "permission-request").length;
      await until("card " + index, () => events.filter((e) => e.type === "permission-request").length === before + 1);
      const card = events.findLast((e) => e.type === "permission-request");
      assert.equal(await client.call("agent:respond-permission", [{ chatId, requestId: card.requestId, decision }]), true);
    }
    await until("modes turn " + (index + 1), () => terminals().length === index + 1);
    pids.push(...nativePids());
  }
  assert.deepEqual(
    terminals().map((e) => e.type),
    ["turn-completed", "turn-completed", "turn-completed"],
  );
  assert.equal(new Set(pids).size, 1, "mode changes keep one native process: " + pids);
  assert.deepEqual(
    events.filter((e) => e.type.startsWith("permission-")),
    trace.cards,
  );
  const argv = execFileSync("ps", ["-p", String(pids[0]), "-o", "command="], { encoding: "utf8" });
  assert.ok(argv.includes("--permission-mode bypassPermissions"), argv);
  const snapshot = await client.call("project:snapshot", [project]);
  assert.equal(snapshot.state.sessions["1"].permissionMode, "ask", "the owner keeps the last turn's mode");
}
// Three composer-shaped sends (the desktop's agentRuns.send payload, default Settings first) through the
// production Node client. The fake child asserts the Node-recorded launch options and control order
// itself; this checks processes, generations and the saved transcript.
async function ordinary({ client, events, project, child }) {
  const trace = require("../../rust-claude/tests/fixtures/conformance/claude-ordinary.json");
  const terminals = () => events.filter((e) => ["turn-completed", "turn-failed", "turn-cancelled"].includes(e.type));
  // Every native child of the fixture owner; the old generation may still be exiting.
  const nativePids = () =>
    execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map(Number);
  const pids = [];
  let overlap = false;
  for (const [index, turn] of trace.turns.entries()) {
    const sent = await client.call("chat:send", [
      {
        projectPath: project,
        clientMessageId: "ordinary-" + index,
        sessionId: 1,
        worktreeId: 1,
        body: turn.prompt,
        images: [],
        files: [],
        prompt: turn.prompt,
        provider: "claude",
        model: trace.request.model,
        permissionMode: "ask",
        effort: trace.request.effort,
        ultracode: false,
        fastMode: false,
        replies: turn.replies,
        tldrEnabled: turn.tldrEnabled,
      },
    ]);
    assert.equal(sent.sessionId, 1);
    await until("ordinary turn " + (index + 1), () => terminals().length === index + 1);
    const live = nativePids();
    const fresh = live.filter((pid) => !pids.includes(pid));
    if (index > 0 && live.includes(pids[0]) && fresh.length) overlap = true;
    pids.push(fresh.length === 1 ? fresh[0] : live.length === 1 ? live[0] : NaN);
    assert.ok(Number.isSafeInteger(pids[index]) && pids[index] > 1, JSON.stringify(live));
  }
  assert.deepEqual(
    terminals().map((e) => e.type),
    ["turn-completed", "turn-completed", "turn-completed"],
  );
  assert.equal(pids[1], pids[0], "concise -> normal keeps the native process");
  assert.notEqual(pids[2], pids[0], "TLDR off starts a new native process");
  await until("old native process reaped", () => {
    try {
      process.kill(pids[0], 0);
      return false;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return true;
    }
  });
  console.log(JSON.stringify({ ordinaryPids: pids, oldStillExitingWhenTurn3Completed: overlap }));
  const argv = execFileSync("ps", ["-p", String(pids[2]), "-o", "command="], { encoding: "utf8" });
  assert.ok(argv.includes("--resume=fixture-session"), argv);
  assert.ok(!argv.includes("Milagre"), "instructions stay in the private file");
  assert.deepEqual(
    events.filter((e) => ["turn-started", "session-started", "turn-completed"].includes(e.type)).map((e) => e.type),
    trace.events,
  );
  // Let the old generation's late Exited arrive, then check the new turn stayed completed.
  await delay(800);
  assert.equal(events.filter((e) => e.type === "turn-failed").length, 0);
  const messages = await client.call("chat:messages", [project, 1]);
  for (const turn of trace.turns) assert.equal(messages.messages.filter((m) => m.body === turn.prompt).length, 1);
  assert.equal(messages.messages.filter((m) => m.body === "Claude fixture hello").length, 3);
}
(async () => {
  for (const name of [
    "reply",
    "permission",
    "question",
    "stop",
    "crash",
    "unicode",
    "content",
    "queue",
    "design",
    "content-allow",
    "content-deny",
    "ordinary",
    "modes",
    "live-modes",
  ])
    await scenario(name);
  console.log("Claude owner Node client conformance passed (14 scenarios)");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

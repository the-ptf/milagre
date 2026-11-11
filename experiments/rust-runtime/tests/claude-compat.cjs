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
    await client.call("project:open", [project]);
    await runtime.openProject(project);
    const chatId = project + "#1";
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
    if (name === "permission") {
      await until("permission card", () => events.some((e) => e.type === "permission-request"));
      const card = events.find((e) => e.type === "permission-request");
      assert.equal(await client.call("agent:respond-permission", [{ chatId, requestId: card.requestId, decision: "allow" }]), true);
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
(async () => {
  for (const name of ["reply", "permission", "question", "stop", "crash", "unicode", "content", "queue", "design"]) await scenario(name);
  console.log("Claude owner Node client conformance passed (9 scenarios)");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

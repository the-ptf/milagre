const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AcpSession } = require("./acp-session.cjs");
const { antigravityAcp } = require("./antigravity-acp.cjs");
const { AntigravitySubagents, decode, recoverAntigravitySubagents, systemMessage } = require("./antigravity-subagents.cjs");

// Recorded from agy 1.3.0 (trimmed, paths replaced): the ACP updates of one turn, interleaved with how many
// lines each transcript had at that moment, and the transcripts themselves.
const FIXTURES = path.join(__dirname, "fixtures", "antigravity-subagents");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

const A = "1225e19f21bf5e7e8b95f83bc5f25758";
const B = "34feddb8ccc15926ebd1ba48502820c1";
const READ_A = "7af0d58f854d98c3c1c02785b612d903";
const READ_B = "578c2d2d6029c3466f33a43754ca307a";

// An AcpSession with no agent process: the fixture's updates go through its own notification handling.
function harness(t, data, { transcripts = true, garble = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-agy-subagents-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let clock = 1_000_000;
  const events = [];
  const session = new AcpSession({
    cwd: home,
    command: "/opt/agy",
    env: { GEMINI_HOME: home },
    config: { ...antigravityAcp, subagents: (options) => new AntigravitySubagents({ ...options, pollMs: 0, now: () => clock }) },
    emit: (event) => events.push(event),
  });
  session.state.sessionId = data.sessionId;
  const file = (id) => path.join(home, "antigravity-acp", "brain", id, ".system_generated", "logs", "transcript.jsonl");
  const write = (id, count) => {
    if (!transcripts) return;
    fs.mkdirSync(path.dirname(file(id)), { recursive: true });
    const lines = garble
      ? ["{not json", JSON.stringify({ step_index: "x" }), JSON.stringify({ step_index: 1, type: "INVOKE_SUBAGENT", content: 7 })]
      : data.transcripts[id].slice(0, count).map((step) => JSON.stringify(step).replaceAll("{{HOME}}", home));
    fs.writeFileSync(file(id), lines.map((line) => `${line}\n`).join(""));
  };
  const begin = () => {
    session.turnActive = true;
    session.cancelRequested = false;
    session.subagents.beginTurn();
  };
  // Plays the script on from where it stopped, up to (not including) the step `until` picks; each step is 100 ms after the last.
  let cursor = 0;
  const play = (until = () => false) => {
    for (; cursor < data.script.length; cursor++) {
      const step = data.script[cursor];
      if (until(step)) return;
      clock += 100;
      if (step.transcript) write(step.transcript, step.lines);
      if (step.acp) session.handleNotification("session/update", { sessionId: data.sessionId, update: step.acp });
      session.subagents.poll();
      if (step.end) {
        cursor++;
        return session.finishTurn([{ type: "turn-completed" }]);
      }
    }
  };
  const agents = () => {
    const latest = new Map();
    for (const event of events) if (event.type === "subagent-update") latest.set(event.agent.id, event.agent);
    return latest;
  };
  const steps = () => events.filter((event) => event.type === "step-started").map((event) => event.step);
  return {
    session,
    events,
    home,
    write,
    begin,
    play,
    agents,
    steps,
    tick: (ms) => {
      clock += ms;
    },
  };
}

test("reads double-encoded transcript args and a child's message", () => {
  assert.equal(decode('"sleep 6; cat a.txt"'), "sleep 6; cat a.txt");
  assert.deepEqual(decode('[{"Role":"A"}]'), [{ Role: "A" }]);
  assert.equal(decode("not json"), "not json");
  assert.deepEqual(
    systemMessage({
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-08T12:06:09Z sender=${A} priority=MESSAGE_PRIORITY_HIGH content=Line one\nline two\n</SYSTEM_MESSAGE>`,
    }),
    { sender: A, text: "Line one\nline two" },
  );
});

test("two parallel children: titles, prompts, their own commands, results and the launch step", async (t) => {
  const run = harness(t, fixture("parallel-commands"));
  run.begin();
  await run.play();
  const agents = run.agents();
  assert.deepEqual([...agents.keys()], [A, B]);
  const a = agents.get(A);
  const b = agents.get(B);
  assert.equal(a.title, "Task Runner A");
  assert.equal(b.title, "Task Runner B");
  assert.match(a.prompt, /^Run the shell command 'sleep 6; cat a.txt'/);
  assert.deepEqual([a.status, b.status], ["completed", "completed"]);
  assert.equal(a.latestActivity, "Finished");
  assert.equal(a.transcript.find((row) => row.id === "result").text, "File a: hello from a.");
  assert.equal(b.transcript.find((row) => row.id === "result").text, "File b: hello from b.");
  // The child's commands are its rows, not the parent's steps.
  assert.match(a.transcript.find((row) => row.id === `${A}:2`).text, /^Ran `sleep 6; cat a.txt`\n\$ sleep 6; cat a.txt\nFile a: hello from a\./);
  const stepIds = run.steps().map((step) => step.id);
  assert.deepEqual(stepIds, [`${run.session.state.sessionId}:1`]);
  const retitle = run.events.find((event) => event.type === "step-completed" && event.title);
  assert.deepEqual(retitle, {
    type: "step-completed",
    id: `${run.session.state.sessionId}:1`,
    status: "done",
    title: "Started 2 subagents: `Task Runner A`, `Task Runner B`",
  });
  // The parent waits on its children between its own replies, and stops once they are done.
  const waiting = run.events.filter((event) => event.type === "subagents-waiting").map((event) => event.waiting);
  assert.ok(waiting.includes(true));
  assert.equal(waiting.at(-1), false);
  assert.equal(run.events.at(-1).type, "turn-completed");
});

test("a child's tool call is the child's even before the transcript names it", async (t) => {
  const data = fixture("parallel-commands");
  const run = harness(t, data);
  run.begin();
  run.play((step) => step.transcript === A);
  // No transcript yet: a call with a child's prefix still belongs to a child.
  run.session.handleNotification("session/update", {
    sessionId: data.sessionId,
    update: { sessionUpdate: "tool_call", toolCallId: `${A}:9`, title: "ls", kind: "execute", status: "in_progress", rawInput: { command_line: "ls" } },
  });
  assert.equal(run.agents().get(A).status, "running");
  assert.equal(run.agents().get(A).latestActivity, "Ran `ls`");
  assert.equal(run.steps().filter((step) => step.id.startsWith(A)).length, 0);
});

test("unattributed reads while children run come from the children's transcripts", async (t) => {
  const run = harness(t, fixture("parallel-reads"));
  run.begin();
  await run.play();
  const agents = run.agents();
  assert.deepEqual([...agents.keys()].toSorted(), [READ_A, READ_B].toSorted());
  assert.equal(agents.get(READ_A).title, "Reader of a.txt");
  assert.equal(agents.get(READ_B).title, "Reader of b.txt");
  assert.ok(agents.get(READ_A).transcript.some((row) => row.kind === "tool" && row.text === "Read `a.txt`"));
  assert.ok(agents.get(READ_B).transcript.some((row) => row.kind === "tool" && row.text === "Read `b.txt`"));
  assert.match(agents.get(READ_B).transcript.find((row) => row.id === "result").text, /File b: hello from b\./);
  assert.deepEqual([agents.get(READ_A).status, agents.get(READ_B).status], ["completed", "completed"]);
  // No call_* step, started or completed, reaches the parent.
  const ids = run.events.flatMap((event) => (event.type === "step-started" ? [event.step.id] : event.type === "step-completed" ? [event.id] : []));
  assert.deepEqual([...new Set(ids)], ["0f02de8b-dedf-40f3-8ba1-52469c3dfbd0:1"]);
});

const secondRead = (step) => step.acp?.toolCallId === "call_337070";
for (const [name, options] of [
  ["missing", { transcripts: false }],
  ["garbled", { garble: true }],
]) {
  test(`${name} transcripts leave the launch a plain step and the reads the parent's`, async (t) => {
    const run = harness(t, fixture("parallel-reads"), options);
    run.begin();
    run.play(secondRead);
    // The read waits a moment for the launch's children, then is the parent's after all.
    assert.equal(run.steps().filter((step) => step.id.startsWith("call_")).length, 0);
    run.tick(10_000);
    run.session.subagents.poll();
    assert.deepEqual(
      run.steps().map((step) => step.title),
      ["Used `start_subagent`", "Read `a.txt`"],
    );
    await run.play((step) => step.end);
    await run.session.finishTurn([{ type: "turn-completed" }]);
    assert.equal(run.events.filter((event) => event.type === "subagent-update").length, 0);
    assert.deepEqual(
      run.steps().map((step) => step.id),
      ["0f02de8b-dedf-40f3-8ba1-52469c3dfbd0:1", "call_325885", "call_337070", "call_196524"],
    );
    assert.equal(run.events.filter((event) => event.type === "step-completed" && event.title).length, 0);
  });
}

test("Stop settles the children still running as cancelled", async (t) => {
  const run = harness(t, fixture("parallel-commands"));
  run.begin();
  run.play((step) => step.acp?.toolCallId === `${B}:2`);
  assert.deepEqual(
    [...run.agents().values()].map((agent) => agent.status),
    ["running", "running"],
  );
  run.session.cancelRequested = true;
  await run.session.finishTurn([{ type: "turn-cancelled" }]);
  assert.deepEqual(
    [...run.agents().values()].map((agent) => agent.status),
    ["cancelled", "cancelled"],
  );
  assert.equal(run.events.at(-1).type, "turn-cancelled");
});

test("children still running when a turn ends go on reporting until they finish", async (t) => {
  const data = fixture("parallel-commands");
  const run = harness(t, data);
  run.begin();
  run.play((step) => step.transcript === B && step.lines === 5);
  await run.session.finishTurn([{ type: "turn-completed" }]);
  assert.equal(run.agents().get(B).status, "running");
  run.write(B, 8);
  run.write(data.sessionId, 8);
  run.session.subagents.poll();
  assert.equal(run.agents().get(B).status, "completed");
  // Closing the session later finds nothing left to settle.
  const before = run.events.length;
  await run.session.close();
  assert.equal(run.events.slice(before).filter((event) => event.type === "subagent-update").length, 0);
});

test("children the transcript knew from an earlier turn are not replayed", async (t) => {
  const data = fixture("parallel-commands");
  const run = harness(t, data);
  run.write(data.sessionId, 8);
  run.write(A, 8);
  run.write(B, 8);
  run.begin();
  run.session.handleNotification("session/update", {
    sessionId: data.sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: `${data.sessionId}:9`,
      title: "Running start_subagent",
      kind: "other",
      status: "in_progress",
      rawInput: {},
    },
  });
  run.session.subagents.poll();
  assert.equal(run.events.filter((event) => event.type === "subagent-update").length, 0);
});

test("closing the session cancels the children it was still watching", async (t) => {
  const run = harness(t, fixture("parallel-commands"));
  run.begin();
  run.play((step) => step.acp?.toolCallId === `${B}:2`);
  await run.session.close();
  assert.deepEqual(
    [...run.agents().values()].map((agent) => agent.status),
    ["cancelled", "cancelled"],
  );
});

// A GEMINI_HOME on disk as the app left it: `counts` says how many steps of each recorded transcript are there.
function savedHome(t, counts) {
  const data = fixture("parallel-commands");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-agy-recover-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [id, count] of Object.entries(counts)) {
    const file = path.join(home, "antigravity-acp", "brain", id, ".system_generated", "logs", "transcript.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      data.transcripts[id]
        .slice(0, count)
        .map((step) => `${JSON.stringify(step).replaceAll("{{HOME}}", home)}\n`)
        .join(""),
    );
  }
  return { home, parentId: data.sessionId, file: (id) => path.join(home, "antigravity-acp", "brain", id, ".system_generated", "logs", "transcript.jsonl") };
}
const saved = (id, extra = {}) => ({
  id,
  title: `Task ${id}`,
  status: "unknown",
  startedAt: 10,
  updatedAt: 100,
  transcript: [],
  latestActivity: "Session disconnected.",
  ...extra,
});

test("recovery finishes the child whose report the parent holds and leaves the other unknown", (t) => {
  const { home, parentId } = savedHome(t, { [fixture("parallel-commands").sessionId]: 5, [A]: 3, [B]: 3 });
  const events = recoverAntigravitySubagents({ home, parentId, agents: [saved(A), saved(B)] });
  assert.equal(events.length, 1);
  const { agent } = events[0];
  assert.equal(events[0].type, "subagent-update");
  assert.equal(agent.id, A);
  assert.equal(agent.status, "completed");
  assert.equal(agent.latestActivity, "Finished");
  assert.equal(agent.transcript.find((row) => row.id === "result").text, "File a: hello from a.");
  assert.ok(agent.updatedAt >= 100 && agent.endedAt >= agent.updatedAt - 1);
});

test("recovery falls back to the child's own send_message, and skips archived, known and the parent's own entries", (t) => {
  const { home, parentId } = savedHome(t, { [fixture("parallel-commands").sessionId]: 4, [A]: 8, [B]: 5 });
  const agents = [saved(A), saved(B), saved("archived", { archived: true }), saved("running", { status: "running" }), saved(parentId)];
  const events = recoverAntigravitySubagents({ home, parentId, agents });
  assert.deepEqual(
    events.map((event) => [event.agent.id, event.agent.status, event.agent.transcript[0].text]),
    [[A, "completed", "File a: hello from a."]],
  );
});

test("recovery is empty without evidence: no home, no parent, no files, garbled lines", (t) => {
  const { home, parentId, file } = savedHome(t, {});
  const agents = [saved(A), saved(B)];
  assert.deepEqual(recoverAntigravitySubagents({ home, parentId, agents }), []);
  assert.deepEqual(recoverAntigravitySubagents({ home: path.join(home, "missing"), parentId, agents }), []);
  assert.deepEqual(recoverAntigravitySubagents({ home: undefined, parentId, agents }), []);
  assert.deepEqual(recoverAntigravitySubagents({ home, parentId: undefined, agents }), []);
  assert.deepEqual(recoverAntigravitySubagents({ home, parentId, agents: undefined }), []);
  assert.deepEqual(recoverAntigravitySubagents({ home, parentId, agents: [saved("../escape")] }), []);
  for (const id of [parentId, A]) {
    fs.mkdirSync(path.dirname(file(id)), { recursive: true });
    fs.writeFileSync(file(id), '{not json\n{"step_index":"x"}\n{"step_index":1,"type":"SYSTEM_MESSAGE","content":7}\n\x00\x01 garbage');
  }
  assert.deepEqual(recoverAntigravitySubagents({ home, parentId, agents }), []);
  // An unreadable transcript (a directory where the file should be) is no evidence either.
  fs.rmSync(file(A));
  fs.mkdirSync(file(A));
  assert.deepEqual(recoverAntigravitySubagents({ home, parentId, agents }), []);
});

test("recovery reads a final report that has no newline after it", (t) => {
  const { home, parentId, file } = savedHome(t, { [fixture("parallel-commands").sessionId]: 5 });
  const last = fixture("parallel-commands").transcripts[parentId][6];
  fs.appendFileSync(file(parentId), JSON.stringify(last));
  const events = recoverAntigravitySubagents({ home, parentId, agents: [saved(B)] });
  assert.equal(events[0].agent.transcript[0].text, "File b: hello from b.");
});

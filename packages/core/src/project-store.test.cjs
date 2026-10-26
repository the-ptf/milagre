const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { saveProjectState, stateFile } = require("./project-store.cjs");

async function tempProject(t) {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-store-"));
  t.after(() => fs.rm(projectPath, { recursive: true, force: true }));
  return projectPath;
}

test("concurrent saves leave valid JSON equal to the last save", async (t) => {
  const projectPath = await tempProject(t);
  // A long history followed by a short one: interleaved writes leave the long one's tail behind.
  const long = { next_id: 5001, messages: Array.from({ length: 5000 }, (_, id) => ({ id, session_id: 2, body: "x".repeat(200) })) };
  const short = { next_id: 2, messages: [{ id: 1, session_id: 2, body: "hi" }] };

  const { ProjectStates } = require("./project-states.cjs");
  const states = new ProjectStates({ read: async () => ({}), save: saveProjectState });
  await Promise.all([states.update(projectPath, () => long), states.update(projectPath, () => short)]);
  await states.close();

  assert.deepEqual(await require("./project-store.cjs").readProjectState(projectPath), short);
});

test("saves leave no temporary files behind", async (t) => {
  const projectPath = await tempProject(t);
  for (let index = 0; index < 5; index++) await saveProjectState(projectPath, { next_id: index });

  assert.deepEqual(await fs.readdir(path.join(projectPath, ".milagre")), ["coordination.json"]);
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile(projectPath), "utf8")), { next_id: 4 });
});

test("a failed save rejects without blocking the next one", async (t) => {
  const projectPath = await tempProject(t);
  const circular = {};
  circular.self = circular;

  await assert.rejects(saveProjectState(projectPath, circular));
  await saveProjectState(projectPath, { next_id: 3 });

  assert.deepEqual(JSON.parse(await fs.readFile(stateFile(projectPath), "utf8")), { next_id: 3 });
  assert.deepEqual(await fs.readdir(path.join(projectPath, ".milagre")), ["coordination.json"]);
});

const subagentState = (...transcripts) => ({
  next_id: 3,
  messages: [],
  sessions: {
    1: {
      id: 1,
      subagents: transcripts.map((text, index) => ({
        id: `agent-${index}`,
        title: "Review",
        startedAt: 1,
        updatedAt: 2,
        transcript: [{ id: "m", kind: "message", text }],
      })),
    },
  },
});
const sidecars = async (projectPath) => (await fs.readdir(path.join(projectPath, ".milagre", "subagents"))).sort();
const referenced = async (projectPath) =>
  JSON.parse(await fs.readFile(stateFile(projectPath), "utf8")).sessions[1].subagents.map((agent) => agent.transcriptFile);
const NOW = { sweepMinAgeMs: 0 };

test("an unchanged save writes no sidecar again, a changed agent writes only its own", async (t) => {
  const projectPath = await tempProject(t);
  await saveProjectState(projectPath, subagentState("one", "two"), NOW);
  const links = t.mock.method(fs, "link");
  await saveProjectState(projectPath, subagentState("one", "two"), NOW);
  assert.equal(links.mock.callCount(), 0);
  await saveProjectState(projectPath, subagentState("one", "TWO"), NOW);
  assert.equal(links.mock.callCount(), 1);
  assert.equal((await sidecars(projectPath)).length, 2);
});

test("a changed transcript writes a new sidecar and removes the superseded one", async (t) => {
  const projectPath = await tempProject(t);
  await saveProjectState(projectPath, subagentState("one"), NOW);
  const [first] = await referenced(projectPath);
  await saveProjectState(projectPath, subagentState("one, and more"), NOW);
  const [second] = await referenced(projectPath);
  assert.notEqual(first, second);
  assert.deepEqual(await sidecars(projectPath), [second]);
  const { readProjectState } = require("./project-store.cjs");
  assert.equal((await readProjectState(projectPath)).sessions[1].subagents[0].transcript[0].text, "one, and more");
});

test("sidecars the state still references survive, and nothing else in the folder is touched", async (t) => {
  const projectPath = await tempProject(t);
  await saveProjectState(projectPath, subagentState("one", "two"), NOW);
  const directory = path.join(projectPath, ".milagre", "subagents");
  const [kept] = await referenced(projectPath);
  const orphan = `${"a".repeat(64)}.json`;
  await fs.writeFile(path.join(directory, orphan), "[]");
  await fs.writeFile(path.join(directory, "notes.txt"), "mine");
  await fs.writeFile(path.join(directory, `.${orphan}.tmp`), "[]");
  await fs.mkdir(path.join(directory, `${"b".repeat(64)}.json.d`));
  // An agent whose transcript went missing keeps its older sidecar listed, so it must stay.
  const older = `${"c".repeat(64)}.json`;
  await fs.writeFile(path.join(directory, older), "[]");
  const state = subagentState("one", "two");
  state.sessions[1].subagents[0].transcriptFiles = [older];
  await saveProjectState(projectPath, state, NOW);
  // Settled digests mean no new sidecar; the sweep is skipped, so run one that did write.
  // A new transcript array, as the app makes one (states are replaced, never changed in place).
  const agent = state.sessions[1].subagents[1];
  agent.transcript = [{ ...agent.transcript[0], text: "two!" }];
  await saveProjectState(projectPath, state, NOW);
  const names = await fs.readdir(directory);
  assert.ok(names.includes(kept));
  assert.ok(names.includes(older));
  assert.ok(names.includes("notes.txt"));
  assert.ok(names.includes(`.${orphan}.tmp`));
  assert.equal(names.includes(orphan), false);
});

test("a sidecar younger than the grace period is left for an in-flight save", async (t) => {
  const projectPath = await tempProject(t);
  await saveProjectState(projectPath, subagentState("one"));
  await saveProjectState(projectPath, subagentState("two"));
  assert.equal((await sidecars(projectPath)).length, 2);
});

test("a remembered digest is not trusted once its sidecar is gone", async (t) => {
  const projectPath = await tempProject(t);
  await saveProjectState(projectPath, subagentState("one"), NOW);
  const [file] = await referenced(projectPath);
  await fs.rm(path.join(projectPath, ".milagre", "subagents", file));
  await saveProjectState(projectPath, subagentState("one"), NOW);
  assert.deepEqual(await sidecars(projectPath), [file]);
});

test("saves without subagents never create the content folder", async (t) => {
  const projectPath = await tempProject(t);
  await saveProjectState(projectPath, { next_id: 1, sessions: { 1: { id: 1 } } }, NOW);
  assert.deepEqual(await fs.readdir(path.join(projectPath, ".milagre")), ["coordination.json"]);
});

test("many subagents round-trip through bounded concurrent hydration", async (t) => {
  const projectPath = await tempProject(t);
  const { readProjectState } = require("./project-store.cjs");
  const texts = Array.from({ length: 20 }, (_, index) => `transcript ${index}`);
  await saveProjectState(projectPath, subagentState(...texts), NOW);
  const loaded = await readProjectState(projectPath);
  assert.deepEqual(
    loaded.sessions[1].subagents.map((agent) => agent.transcript[0].text),
    texts,
  );
  const calls = t.mock.method(fs, "mkdir");
  await readProjectState(projectPath);
  assert.equal(calls.mock.callCount(), 2); // contentDirectory once for the whole Project, not once per agent
});

test("only a durable save syncs to disk; routine saves just rename", async (t) => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-store-durable-"));
  t.after(() => fs.rm(projectPath, { recursive: true, force: true }));
  const probe = await fs.open(__filename, "r");
  const syncs = t.mock.method(Object.getPrototypeOf(probe), "sync");
  await probe.close();
  await saveProjectState(projectPath, { sessions: {} });
  assert.equal(syncs.mock.callCount(), 0);
  await saveProjectState(projectPath, { sessions: { 1: { id: 1 } } }, { durable: true });
  assert.equal(syncs.mock.callCount(), 2, "the file, then its folder after the rename");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(projectPath, ".milagre/coordination.json"), "utf8")).sessions, { 1: { id: 1 } });
});

const withOutput = (id, label) => ({
  id,
  session_id: 1,
  role: "assistant",
  body: "Done",
  context: null,
  steps: [{ id: `step-${id}`, kind: "shell", title: "Ran a command", status: "done", detail: `$ ${label}\n`.padEnd(5000, "output line\n") }],
});
const detailFiles = async (projectPath) =>
  (await fs.readdir(path.join(projectPath, ".milagre", "details")).catch(() => [])).filter((name) => name.endsWith(".json")).sort();

test("a saved state from before sidecars reads back with its long tool output moved out, and saves small", async (t) => {
  const { readProjectState, saveProjectState } = require("./project-store.cjs");
  const { withDetails } = require("./project-content.cjs");
  const projectPath = await tempProject(t);
  const legacy = { next_id: 3, sessions: {}, messages: [withOutput(1, "npm test"), withOutput(2, "npm run lint")] };
  await fs.mkdir(path.join(projectPath, ".milagre"));
  await fs.writeFile(stateFile(projectPath), JSON.stringify(legacy));
  const read = await readProjectState(projectPath);
  assert.equal(
    read.messages.every((message) => message.steps[0].hasDetail && !message.steps[0].detail),
    true,
  );
  assert.equal((await detailFiles(projectPath)).length, 2);
  await saveProjectState(projectPath, read, { sweepMinAgeMs: 0 });
  assert.ok((await fs.stat(stateFile(projectPath))).size < 1000);
  assert.deepEqual(await withDetails(projectPath, (await readProjectState(projectPath)).messages[1]), legacy.messages[1]);
});

test("a details sidecar no saved message points at is removed by the next save that writes one", async (t) => {
  const { readProjectState, saveProjectState } = require("./project-store.cjs");
  const projectPath = await tempProject(t);
  await saveProjectState(projectPath, { next_id: 3, sessions: {}, messages: [withOutput(1, "one"), withOutput(2, "two")] }, { sweepMinAgeMs: 0 });
  const saved = await readProjectState(projectPath);
  assert.equal((await detailFiles(projectPath)).length, 2);
  // The first chat's worktree went away, and its messages with it; the other chat replied again.
  await saveProjectState(projectPath, { ...saved, messages: [saved.messages[1], withOutput(3, "three")] }, { sweepMinAgeMs: 0 });
  const kept = (await readProjectState(projectPath)).messages.map((message) => message.detailFile).sort();
  assert.deepEqual(await detailFiles(projectPath), kept);
  assert.equal(kept.includes(saved.messages[0].detailFile), false);
});

const reply = (id, session_id, body = "Done") => ({ id, session_id, role: "assistant", body, context: null });
test("messages move from coordination.json to chats.db on the first save, in their order, and read back the same", async (t) => {
  const { readProjectState, saveProjectState } = require("./project-store.cjs");
  const projectPath = await tempProject(t);
  // Ids out of order in the array happen (a message re-sent after a reply split in two); the order is kept.
  const legacy = { next_id: 9, sessions: { 1: { id: 1 }, 2: { id: 2 } }, messages: [reply(3, 1), reply(5, 2), reply(4, 1), reply(8, 2, "last")] };
  await fs.mkdir(path.join(projectPath, ".milagre"));
  await fs.writeFile(stateFile(projectPath), JSON.stringify(legacy));
  const read = await readProjectState(projectPath);
  assert.deepEqual(read, legacy);
  await saveProjectState(projectPath, read, NOW);
  const saved = JSON.parse(await fs.readFile(stateFile(projectPath), "utf8"));
  assert.deepEqual(saved.messages, { storedIn: "chats.db", format: 2 });
  assert.equal(Array.isArray(saved.messages), false, "an older release, which reads messages as an array, fails to open it rather than showing empty chats");
  assert.deepEqual(await readProjectState(projectPath), legacy);
  assert.deepEqual(JSON.parse(await fs.readFile(`${stateFile(projectPath)}.before-chats-db`, "utf8")), legacy, "the old file is kept once");
  await saveProjectState(projectPath, { ...legacy, next_id: 10 }, NOW);
  assert.deepEqual(JSON.parse(await fs.readFile(`${stateFile(projectPath)}.before-chats-db`, "utf8")), legacy, "and never overwritten");
});

test("a save writes only the messages that changed and removes the ones that are gone", async (t) => {
  const { readProjectState, saveProjectState } = require("./project-store.cjs");
  const { DatabaseSync } = require("node:sqlite");
  const projectPath = await tempProject(t);
  const first = { next_id: 4, sessions: { 1: { id: 1 } }, messages: [reply(1, 1), reply(2, 1), reply(3, 1)] };
  await saveProjectState(projectPath, first, NOW);
  // A row changed behind the store's back shows whether the next save rewrites it.
  const touch = (sql) => {
    const db = new DatabaseSync(path.join(projectPath, ".milagre", "chats.db"));
    db.exec(sql);
    db.close();
  };
  touch(`UPDATE messages SET payload = '{"id":1,"session_id":1,"role":"assistant","body":"untouched","context":null}' WHERE id = 1`);
  const next = { ...first, next_id: 5, messages: [first.messages[0], { ...first.messages[1], body: "edited" }, reply(4, 1)] };
  await saveProjectState(projectPath, next, NOW);
  const back = await readProjectState(projectPath);
  assert.deepEqual(
    back.messages.map((message) => [message.id, message.body]),
    [
      [1, "untouched"],
      [2, "edited"],
      [4, "Done"],
    ],
  );
});

test("a state that points at a missing chats.db fails to read instead of opening with no messages", async (t) => {
  const { readProjectState, saveProjectState } = require("./project-store.cjs");
  const projectPath = await tempProject(t);
  await saveProjectState(projectPath, { next_id: 2, sessions: {}, messages: [reply(1, 1)] }, NOW);
  await fs.rm(path.join(projectPath, ".milagre", "chats.db"));
  await assert.rejects(readProjectState(projectPath), /chats\.db, which is missing/);
});

test("suggestions stay live but never persist or restore across a host restart", async (t) => {
  const project = await tempProject(t);
  const session = { id: 1, provider: "claude", native_session_id: "native", suggestion: { text: "Continue", turnId: "t" }, suggestionTurnId: "t" };
  const state = { sessions: { 1: session }, messages: [], next_id: 2 };
  await saveProjectState(project, state);
  assert.equal(state.sessions[1].suggestion.text, "Continue", "saving does not erase live reconnect state");
  const saved = JSON.parse(await fs.readFile(stateFile(project), "utf8"));
  assert.equal(saved.sessions[1].suggestion, undefined);
  assert.equal(saved.sessions[1].suggestionTurnId, undefined);
  const { readProjectState } = require("./project-store.cjs");
  assert.equal((await readProjectState(project)).sessions[1].native_session_id, "native");
  // Also clean legacy snapshots containing fields written before this boundary was enforced.
  await fs.writeFile(stateFile(project), JSON.stringify(state));
  const restored = (await readProjectState(project)).sessions[1];
  assert.equal(restored.suggestion, undefined);
  assert.equal(restored.suggestionTurnId, undefined);
});

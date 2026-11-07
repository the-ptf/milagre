const assert = require("node:assert/strict");
const { readProjectState: readSavedState } = require("./project-store.cjs");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { mergeWorktreeChats } = require("./worktree-chats.cjs");

const gitConfig = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

// A repository with an initial commit and linked worktrees, like a project opened before #117.
async function fixture(t, linkedNames = ["linked"]) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-worktree-chats-")));
  const runtimes = [];
  t.after(async () => {
    try {
      for (const runtime of runtimes) await runtime.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  execFileSync("git", ["-C", project, ...gitConfig, "commit", "--allow-empty", "-m", "Initial"], { stdio: "ignore" });
  const linked = {};
  for (const name of linkedNames) {
    linked[name] = path.join(dir, name);
    execFileSync("git", ["-C", project, "worktree", "add", "-b", name, linked[name]], { stdio: "ignore" });
  }
  const dataDir = path.join(dir, "profile");
  const warnings = [];
  const make = (overrides = {}) => {
    const runtime = createRuntime({ dataDir, cwd: project, version: "test", environmentReady: Promise.resolve(), ...overrides });
    runtimes.push(runtime);
    return runtime;
  };
  t.mock.method(console, "warn", (...args) => {
    warnings.push(args.join(" "));
  });
  return { dir, project, linked, dataDir, make, warnings };
}

const oldFile = (worktree) => path.join(worktree, ".milagre", "coordination.json");
const mainFile = (project) => path.join(project, ".milagre", "coordination.json");

async function writeOld(worktree, state) {
  await fs.mkdir(path.dirname(oldFile(worktree)), { recursive: true });
  await fs.writeFile(oldFile(worktree), JSON.stringify(state));
}

async function migratedFiles(worktree) {
  return (await fs.readdir(path.join(worktree, ".milagre"))).filter((name) => /^coordination\.json\.migrated-\d{4}-\d\d-\d\dT/.test(name));
}

/** The shape a linked worktree opened as its own project saved: its own ids, the legacy keys and all. */
function oldState({ project, linked, sessions, messages, worktrees = {}, tasks = {}, nextId = 40 }) {
  return {
    next_id: nextId,
    projects: { 1: { id: 1, name: path.basename(linked) } },
    worktrees: {
      1: { id: 1, project_id: 1, path: project, name: "main" },
      2: { id: 2, project_id: 1, path: linked, name: path.basename(linked) },
      ...worktrees,
    },
    sessions,
    connections: {},
    events: [],
    messages,
    approvals: [{ legacy: true }],
    tasks,
    artifacts: {},
    outputs: [{ legacy: true }],
    conflicts: [],
  };
}

const chat = (id, worktreeId, extra = {}) => ({ id, worktree_id: worktreeId, agent_name: "linked", status: "Created", provider: "claude", ...extra });
const message = (id, sessionId, body, extra = {}) => ({ id, session_id: sessionId, body, context: null, role: "user", ...extra });
const sessionsWith = (state, predicate) => Object.values(state.sessions).filter(predicate);
const messagesOf = (state, sessionId) => state.messages.filter((item) => item.session_id === sessionId);

test("a linked worktree's old chats come back with fresh ids, and the old file is renamed", async (t) => {
  const { project, linked, make } = await fixture(t);
  await writeOld(
    linked.linked,
    oldState({
      project,
      linked: linked.linked,
      nextId: 940,
      sessions: {
        903: chat(903, 2, { native_session_id: "native-a", title: "First chat" }),
        904: chat(904, 2, { native_session_id: "native-b", title: "Second chat" }),
        905: chat(905, 2, { title: "Empty placeholder" }),
      },
      messages: [message(906, 903, "Hello A"), message(907, 903, "Reply A", { role: "assistant" }), message(908, 904, "Hello B")],
    }),
  );
  const opened = await make().openProject(project);
  const brought = sessionsWith(opened.state, (session) => ["First chat", "Second chat"].includes(session.title));
  assert.equal(brought.length, 2);
  assert.equal(sessionsWith(opened.state, (session) => session.title === "Empty placeholder").length, 0);
  const linkedWorktree = Object.values(opened.state.worktrees).find((worktree) => worktree.path === linked.linked);
  for (const session of brought) {
    assert.equal(session.worktree_id, linkedWorktree.id);
    assert.ok(session.id < 900, "sessions get fresh ids from the main state");
  }
  const first = brought.find((session) => session.title === "First chat");
  assert.deepEqual(
    messagesOf(opened.state, first.id).map((item) => item.body),
    ["Hello A", "Reply A"],
  );
  assert.ok(
    messagesOf(opened.state, first.id).every((item) => item.id < 900),
    "messages get fresh ids from the main state",
  );
  const ids = [...Object.keys(opened.state.worktrees), ...Object.keys(opened.state.sessions)].map(Number).concat(opened.state.messages.map((item) => item.id));
  assert.equal(new Set(ids).size, ids.length, "no id is used twice");
  assert.ok(opened.state.next_id > Math.max(...ids));
  assert.deepEqual(opened.restoredChats, [{ worktree: "linked", count: 2 }]);

  await assert.rejects(fs.stat(oldFile(linked.linked)), { code: "ENOENT" });
  const [renamed, ...others] = await migratedFiles(linked.linked);
  assert.deepEqual(others, []);
  assert.ok(!renamed.includes(":"), "Windows refuses a colon in a file name");
  const saved = await readSavedState(project);
  assert.equal(Object.values(saved.sessions).filter((session) => session.native_session_id?.startsWith("native-")).length, 2);
  for (const key of ["approvals", "outputs", "connections", "events", "artifacts", "conflicts"]) assert.equal(key in saved, false, `${key} stays behind`);
});

test("a chat the main state already has is not brought back again", async (t) => {
  const { project, linked, make } = await fixture(t);
  // The main checkout already holds two of the chats, as Victor's hand restore left them: one with its native id,
  // and one copy that lost it.
  await fs.mkdir(path.dirname(mainFile(project)), { recursive: true });
  await fs.writeFile(
    mainFile(project),
    JSON.stringify({
      next_id: 100,
      projects: { 1: { id: 1, name: "project" } },
      worktrees: { 10: { id: 10, project_id: 1, path: project, name: "main" }, 11: { id: 11, project_id: 1, path: linked.linked, name: "linked" } },
      sessions: {
        12: chat(12, 11, { native_session_id: "native-a", title: "Restored A" }),
        13: chat(13, 11, { title: "Restored C, no native id" }),
        17: chat(17, 11, { title: "Restored review" }),
      },
      messages: [
        message(14, 12, "Hello A"),
        message(15, 13, "Hello C"),
        message(16, 13, "Reply C", { role: "assistant" }),
        message(18, 17, "/review"),
        message(19, 17, "Looks good", { role: "assistant" }),
      ],
      tasks: {},
    }),
  );
  await writeOld(
    linked.linked,
    oldState({
      project,
      linked: linked.linked,
      sessions: {
        3: chat(3, 2, { native_session_id: "native-a", title: "A again" }),
        4: chat(4, 2, { title: "B, no native id" }),
        5: chat(5, 2, { native_session_id: "native-c", title: "C again" }),
        6: chat(6, 2, { title: "D, same first message as C but longer" }),
        7: chat(7, 2, { title: "E, a copy of B" }),
        8: chat(8, 2, { title: "F, /review with another reply" }),
      },
      messages: [
        message(20, 3, "Hello A"),
        message(21, 4, "Hello B"),
        message(22, 5, "Hello C"),
        message(23, 5, "Reply C", { role: "assistant" }),
        message(24, 6, "Hello C"),
        message(25, 6, "Reply D", { role: "assistant" }),
        message(26, 6, "More D"),
        message(27, 7, "Hello B"),
        message(28, 8, "/review"),
        message(29, 8, "Two problems in auth.ts", { role: "assistant" }),
      ],
    }),
  );
  const opened = await make().openProject(project);
  const titles = Object.values(opened.state.sessions)
    .map((session) => session.title)
    .filter(Boolean)
    .sort();
  assert.deepEqual(titles, [
    "B, no native id",
    "D, same first message as C but longer",
    "F, /review with another reply",
    "Restored A",
    "Restored C, no native id",
    "Restored review",
  ]);
  assert.deepEqual(opened.restoredChats, [{ worktree: "linked", count: 3 }]);
  assert.equal((await migratedFiles(linked.linked)).length, 1);
});

test("an old file with only duplicates or empty chats is renamed without a notice", async (t) => {
  const { project, linked, make } = await fixture(t);
  await writeOld(linked.linked, oldState({ project, linked: linked.linked, sessions: { 3: chat(3, 2) }, messages: [] }));
  const opened = await make().openProject(project);
  assert.equal(opened.restoredChats, undefined);
  await assert.rejects(fs.stat(oldFile(linked.linked)), { code: "ENOENT" });
  assert.equal((await migratedFiles(linked.linked)).length, 1);
});

test("a handover pair is remapped together and a link to a chat left behind is dropped", async (t) => {
  const { project, linked, make } = await fixture(t);
  await writeOld(
    linked.linked,
    oldState({
      project,
      linked: linked.linked,
      sessions: {
        3: chat(3, 2, { native_session_id: "from", title: "Handed over", handedOverTo: 4 }),
        4: chat(4, 2, { native_session_id: "to", provider: "codex", title: "Took over", handedOverFrom: 3 }),
        5: chat(5, 2, { native_session_id: "orphan", title: "Points at an empty chat", handedOverTo: 6 }),
        6: chat(6, 2, { title: "Empty", handedOverFrom: 5 }),
      },
      messages: [message(7, 3, "Start"), message(8, 4, "Continue"), message(9, 5, "Alone")],
    }),
  );
  const { state } = await make().openProject(project);
  const byTitle = (title) => Object.values(state.sessions).find((session) => session.title === title);
  const from = byTitle("Handed over");
  const to = byTitle("Took over");
  assert.equal(from.handedOverTo, to.id);
  assert.equal(to.handedOverFrom, from.id);
  assert.equal("handedOverFrom" in from, false);
  const orphan = byTitle("Points at an empty chat");
  assert.equal("handedOverTo" in orphan, false);
  assert.equal(byTitle("Empty"), undefined);
});

test("a worktree missing from the main state is added and an existing one is reused, tasks included", async (t) => {
  const { project, linked, make } = await fixture(t, ["linked", "feature"]);
  await fs.mkdir(path.dirname(mainFile(project)), { recursive: true });
  await fs.writeFile(
    mainFile(project),
    JSON.stringify({
      next_id: 60,
      projects: { 1: { id: 1, name: "project" } },
      worktrees: { 50: { id: 50, project_id: 1, path: project, name: "main" }, 51: { id: 51, project_id: 1, path: linked.linked, name: "linked" } },
      sessions: { 52: chat(52, 51, { title: "Already here" }) },
      messages: [message(53, 52, "Present")],
      tasks: {},
    }),
  );
  await writeOld(
    linked.linked,
    oldState({
      project,
      linked: linked.linked,
      worktrees: { 9: { id: 9, project_id: 1, path: linked.feature, name: "feature", base: "main" } },
      sessions: {
        3: chat(3, 2, { native_session_id: "in-linked", title: "In linked" }),
        4: chat(4, 9, { native_session_id: "in-feature", title: "In feature" }),
      },
      messages: [message(5, 3, "Linked chat"), message(6, 4, "Feature chat")],
      tasks: { 7: { id: 7, worktree_id: 9, title: "Ship it", status: "open" }, 8: { id: 8, worktree_id: 1, title: "Main task", status: "open" } },
    }),
  );
  const { state } = await make().openProject(project);
  const worktrees = Object.values(state.worktrees);
  assert.equal(worktrees.filter((worktree) => worktree.path === linked.linked).length, 1);
  const linkedChat = Object.values(state.sessions).find((session) => session.title === "In linked");
  assert.equal(linkedChat.worktree_id, 51, "the existing worktree is reused");
  const feature = worktrees.find((worktree) => worktree.path === linked.feature);
  assert.ok(feature.id >= 60, "the added worktree gets a fresh id");
  assert.equal(feature.project_id, 1);
  assert.equal(feature.base, "main");
  assert.equal(Object.values(state.sessions).find((session) => session.title === "In feature").worktree_id, feature.id);
  const tasks = Object.values(state.tasks);
  assert.deepEqual(
    tasks.map((task) => [task.title, task.worktree_id]),
    [["Ship it", feature.id]],
  );
  assert.ok(tasks[0].id >= 60 && tasks[0].id !== 7);
});

test("a corrupt old file leaves everything untouched and the project still opens", async (t) => {
  const { project, linked, make, warnings } = await fixture(t);
  await fs.mkdir(path.dirname(oldFile(linked.linked)), { recursive: true });
  const damaged = '{"sessions": {"3": ';
  await fs.writeFile(oldFile(linked.linked), damaged);
  const opened = await make().openProject(project);
  assert.equal(opened.path, project);
  assert.equal(opened.restoredChats, undefined);
  assert.equal(await fs.readFile(oldFile(linked.linked), "utf8"), damaged);
  assert.equal((await migratedFiles(linked.linked)).length, 0);
  assert.equal(warnings.filter((line) => line.includes(oldFile(linked.linked))).length, 1, "one line is logged");
});

test("a failed write leaves the old file in place, and the next open brings the chats back", async (t) => {
  const { project, linked, make, warnings } = await fixture(t);
  await writeOld(
    linked.linked,
    oldState({
      project,
      linked: linked.linked,
      sessions: { 3: chat(3, 2, { native_session_id: "kept", title: "Kept" }) },
      messages: [message(4, 3, "Keep me")],
    }),
  );
  const before = await fs.readFile(oldFile(linked.linked), "utf8");
  const rename = fs.rename;
  let fail = true;
  t.mock.method(fs, "rename", async (...args) => {
    if (fail && String(args[1]) === mainFile(project)) throw new Error("disk full");
    return rename(...args);
  });
  const first = make();
  const opened = await first.openProject(project);
  assert.equal(opened.restoredChats, undefined);
  assert.equal(
    Object.values(opened.state.sessions).some((session) => session.title === "Kept"),
    false,
  );
  assert.equal(await fs.readFile(oldFile(linked.linked), "utf8"), before);
  assert.ok(warnings.some((line) => line.includes("disk full")));
  fail = false;
  await first.close();
  const reopened = await make().openProject(project);
  assert.deepEqual(reopened.restoredChats, [{ worktree: "linked", count: 1 }]);
  assert.ok(Object.values(reopened.state.sessions).some((session) => session.title === "Kept"));
});

test("opening the project again brings nothing back, because the file was renamed", async (t) => {
  const { project, linked, make } = await fixture(t);
  await writeOld(
    linked.linked,
    oldState({
      project,
      linked: linked.linked,
      sessions: { 3: chat(3, 2, { native_session_id: "once", title: "Once" }) },
      messages: [message(4, 3, "Only once")],
    }),
  );
  const first = make();
  assert.deepEqual((await first.openProject(project)).restoredChats, [{ worktree: "linked", count: 1 }]);
  await first.close();
  const second = make();
  const reopened = await second.openProject(project);
  assert.equal(reopened.restoredChats, undefined);
  assert.equal(Object.values(reopened.state.sessions).filter((session) => session.title === "Once").length, 1);
  assert.equal(reopened.state.messages.filter((item) => item.body === "Only once").length, 1);
  assert.equal((await migratedFiles(linked.linked)).length, 1);
});

test("two loads at once merge once", async (t) => {
  const { project, linked, dataDir, make } = await fixture(t);
  await writeOld(
    linked.linked,
    oldState({ project, linked: linked.linked, sessions: { 3: chat(3, 2, { native_session_id: "one", title: "One" }) }, messages: [message(4, 3, "Single")] }),
  );
  // Windows share one runtime; a second runtime (another profile or a daemon) races for the repository's owner lock.
  const runtime = make();
  const other = make({ dataDir: `${dataDir}-other` });
  const results = await Promise.allSettled([
    runtime.openProject(project),
    runtime.openProject(linked.linked),
    runtime.openProject(project),
    other.openProject(project),
  ]);
  const opened = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const refused = results.filter((result) => result.status === "rejected").map((result) => result.reason.message);
  assert.ok(refused.length === 1 || refused.length === 3, "only one runtime owns the repository");
  for (const reason of refused) assert.match(reason, /already owned/);
  assert.equal(opened.filter((result) => result.restoredChats).length, 1, "one window gets the notice");
  await runtime.close();
  await other.close();
  const saved = await readSavedState(project);
  assert.equal(Object.values(saved.sessions).filter((session) => session.title === "One").length, 1);
  assert.equal(saved.messages.filter((item) => item.body === "Single").length, 1);
  assert.equal((await migratedFiles(linked.linked)).length, 1);
});

test("a chat in a worktree git no longer lists stays in the renamed file", async (t) => {
  const { project, linked, make, warnings } = await fixture(t);
  await writeOld(
    linked.linked,
    oldState({
      project,
      linked: linked.linked,
      worktrees: { 9: { id: 9, project_id: 1, path: path.join(path.dirname(project), "removed-long-ago"), name: "removed-long-ago" } },
      sessions: { 3: chat(3, 2, { native_session_id: "here", title: "Here" }), 4: chat(4, 9, { native_session_id: "gone", title: "Gone" }) },
      messages: [message(5, 3, "Visible"), message(6, 4, "Invisible")],
    }),
  );
  const opened = await make().openProject(project);
  assert.deepEqual(opened.restoredChats, [{ worktree: "linked", count: 1 }]);
  assert.equal(
    Object.values(opened.state.sessions).some((session) => session.title === "Gone"),
    false,
  );
  const [renamed] = await migratedFiles(linked.linked);
  assert.ok(JSON.parse(await fs.readFile(path.join(linked.linked, ".milagre", renamed), "utf8")).sessions[4], "the renamed file keeps it");
  assert.equal(warnings.filter((line) => line.includes("left 1 chat in") && line.includes(renamed)).length, 1, "the chat left behind is logged with its count");
});

test("the merge is pure and counts what it skipped", () => {
  const main = {
    next_id: 5,
    projects: { 1: { id: 1, name: "p" } },
    worktrees: { 1: { id: 1, project_id: 1, path: "/p", name: "main" } },
    sessions: { 2: chat(2, 1, { native_session_id: "n" }) },
    messages: [message(3, 2, "x")],
    tasks: {},
  };
  const old = {
    next_id: 9,
    projects: { 1: { id: 1, name: "w" } },
    worktrees: { 1: { id: 1, project_id: 1, path: "/p", name: "main" } },
    sessions: { 2: chat(2, 1, { native_session_id: "n" }), 4: chat(4, 1), 5: chat(5, 1, { native_session_id: "m" }) },
    messages: [message(3, 2, "x"), message(6, 5, "y")],
    tasks: {},
  };
  const frozen = JSON.stringify(main);
  const result = mergeWorktreeChats(main, old);
  assert.equal(JSON.stringify(main), frozen);
  assert.deepEqual(
    { migrated: result.migrated, duplicates: result.duplicates, empty: result.empty, gone: result.gone, messages: result.messages },
    { migrated: 1, duplicates: 1, empty: 1, gone: 0, messages: 1 },
  );
  const added = Object.values(result.state.sessions).find((session) => session.native_session_id === "m");
  assert.equal(added.id, 5);
  assert.equal(result.state.messages.at(-1).id, 6);
  assert.equal(result.state.next_id, 7);
  assert.equal(mergeWorktreeChats(result.state, old).migrated, 0, "merging the same file again adds nothing");
});

for (const [label, shape] of [
  ["a null message", { messages: [null] }],
  ["a null worktree", { worktrees: { 1: null } }],
  ["messages as an object holding null", { messages: { a: null } }],
  ["a null session", { sessions: { 3: null } }],
]) {
  test(`an old file with ${label} leaves both files untouched and the project still opens`, async (t) => {
    const { project, linked, make, warnings } = await fixture(t);
    const state = {
      ...oldState({ project, linked: linked.linked, sessions: { 3: chat(3, 2, { native_session_id: "x" }) }, messages: [message(4, 3, "Hi")] }),
      ...shape,
    };
    await writeOld(linked.linked, state);
    const before = await fs.readFile(oldFile(linked.linked), "utf8");
    const opened = await make().openProject(project);
    assert.equal(opened.path, project);
    assert.equal(opened.restoredChats, undefined);
    assert.equal(await fs.readFile(oldFile(linked.linked), "utf8"), before);
    await assert.rejects(fs.stat(mainFile(project)), { code: "ENOENT" }, "nothing is written to the main checkout");
    assert.equal(warnings.filter((line) => line.includes(oldFile(linked.linked))).length, 1, "one line is logged");
  });
}

test("a main state with more ids than Math.max can spread still merges", () => {
  const messages = Array.from({ length: 200_000 }, (_, index) => message(10 + index, 2, `m${index}`));
  const main = {
    next_id: 1,
    projects: { 1: { id: 1, name: "p" } },
    worktrees: { 1: { id: 1, project_id: 1, path: "/p", name: "main" } },
    sessions: { 2: chat(2, 1) },
    messages,
    tasks: {},
  };
  const old = {
    worktrees: { 1: { id: 1, project_id: 1, path: "/p", name: "main" } },
    sessions: { 5: chat(5, 1, { native_session_id: "n" }) },
    messages: [message(6, 5, "new")],
  };
  const result = mergeWorktreeChats(main, old);
  assert.equal(result.migrated, 1);
  assert.equal(result.state.messages.at(-1).id, 200_011);
});

test("a failed rename after the save brings nothing back twice, even for a chat without a native id", async (t) => {
  const { project, linked, make, warnings } = await fixture(t);
  await writeOld(
    linked.linked,
    oldState({
      project,
      linked: linked.linked,
      sessions: { 3: chat(3, 2, { title: "No native id" }) },
      messages: [message(4, 3, "Only here"), message(5, 3, "Reply", { role: "assistant" })],
    }),
  );
  const rename = fs.rename;
  let fail = true;
  t.mock.method(fs, "rename", async (...args) => {
    if (fail && String(args[0]) === oldFile(linked.linked)) throw new Error("permission denied");
    return rename(...args);
  });
  const first = make();
  assert.deepEqual((await first.openProject(project)).restoredChats, [{ worktree: "linked", count: 1 }]);
  assert.ok(warnings.some((line) => line.includes("couldn't rename") && line.includes("permission denied")));
  await fs.stat(oldFile(linked.linked));
  fail = false;
  await first.close();
  const reopened = await make().openProject(project);
  assert.equal(reopened.restoredChats, undefined);
  assert.equal(Object.values(reopened.state.sessions).filter((session) => session.title === "No native id").length, 1);
  assert.equal(reopened.state.messages.filter((item) => item.body === "Only here").length, 1);
  assert.equal((await migratedFiles(linked.linked)).length, 1, "the second open renames it");
});

test("a crash between the save and the rename brings nothing back twice", async (t) => {
  const { project, linked, make } = await fixture(t);
  await writeOld(
    linked.linked,
    oldState({
      project,
      linked: linked.linked,
      sessions: { 3: chat(3, 2, { title: "Crash survivor" }) },
      messages: [message(4, 3, "Before the crash"), message(5, 3, "Saved", { role: "assistant" })],
    }),
  );
  // A separate process saves the merge, then exits before it can rename the old file.
  const script = `
    const { migrateWorktreeChats } = require(${JSON.stringify(path.join(__dirname, "worktree-chats.cjs"))});
    const { saveProjectState } = require(${JSON.stringify(path.join(__dirname, "project-store.cjs"))});
    const { emptyState } = require(${JSON.stringify(path.join(__dirname, "project-state.cjs"))});
    const [project, linked] = process.argv.slice(1);
    migrateWorktreeChats({ projectPath: project, state: emptyState('project'), linkedWorktrees: [{ path: linked, name: 'linked' }],
      save: async (...args) => { await saveProjectState(...args); process.exit(0); } });`;
  execFileSync(process.execPath, ["-e", script, project, linked.linked], { stdio: "ignore" });
  assert.ok(Object.values((await readSavedState(project)).sessions).some((session) => session.title === "Crash survivor"));
  await fs.stat(oldFile(linked.linked));
  const opened = await make().openProject(project);
  assert.equal(opened.restoredChats, undefined, "nothing new came back");
  assert.equal(Object.values(opened.state.sessions).filter((session) => session.title === "Crash survivor").length, 1);
  assert.equal(opened.state.messages.filter((item) => item.body === "Before the crash").length, 1);
  assert.equal((await migratedFiles(linked.linked)).length, 1);
});

test("a chat whose parked native session is already in the main state is a duplicate", () => {
  const worktrees = { 1: { id: 1, path: "/repo/linked", name: "linked" } };
  const main = {
    next_id: 10,
    projects: { 1: { id: 1 } },
    worktrees,
    sessions: { 2: chat(2, 1, { provider: "codex", native_session_id: "codex-1", native_sessions: { claude: "claude-1" } }) },
    messages: [message(3, 2, "Hello")],
    tasks: {},
  };
  const old = { ...main, next_id: 40, sessions: { 4: chat(4, 1, { native_session_id: "claude-1" }) }, messages: [message(5, 4, "Another opening")] };
  const result = mergeWorktreeChats(main, old);
  assert.equal(result.duplicates, 1);
  assert.equal(result.migrated, 0);
});

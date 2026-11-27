const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createChatSearch } = require("./chat-search.cjs");
const { MESSAGES_MARKER, writeMessages } = require("./chat-db.cjs");

const message = (id, session_id, body, role = "user") => ({ id, session_id, role, body, context: { kind: "worktree" } });

async function savedProject(t, sessions, messages, { inline = false } = {}) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-search-"));
  t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectPath, ".milagre"));
  const state = { sessions, worktrees: { 1: { id: 1, name: "main", path: projectPath } }, messages: inline ? messages : MESSAGES_MARKER };
  fs.writeFileSync(path.join(projectPath, ".milagre", "coordination.json"), JSON.stringify(state));
  if (!inline) await writeMessages(projectPath, messages, new Map());
  return projectPath;
}

function searchOver(projects, open = new Map()) {
  return createChatSearch({
    scopeStates: {
      has: (key) => open.has(key),
      get: async (key) => open.get(key),
      searchableMessages: async (key, chats) => open.get(key).messages.filter((item) => chats.includes(item.session_id)),
    },
    knownProjects: async () => projects,
    nameOf: (projectPath) => path.basename(projectPath),
    idleMs: 10,
  });
}

test("every Project is searched, open or not, and each match names its Project and Chat", async (t) => {
  const closed = await savedProject(t, { 1: { id: 1, worktree_id: 1, title: "Relay deploy", summary: { lastAt: 20 } } }, [
    message(1, 1, "deploy the relay worker with wrangler"),
  ]);
  const openPath = "/open/project";
  const open = new Map([
    [openPath, { sessions: { 4: { id: 4, title: "Simulator" } }, worktrees: {}, messages: [message(9, 4, "wrangler taps the simulator")] }],
  ]);
  const { matches, failed, searched } = await searchOver([closed, openPath], open).search("wrangler");
  assert.equal(searched, 2);
  assert.deepEqual(failed, []);
  assert.deepEqual(
    matches.map((match) => [match.projectName, match.chat.title, match.message.id]).sort(),
    [
      ["project", "Simulator", 9],
      [path.basename(closed), "Relay deploy", 1],
    ].sort(),
  );
  const relay = matches.find((match) => match.projectPath === closed);
  assert.deepEqual(relay.chat, { id: 1, title: "Relay deploy", archived: false, lastAt: 20, branch: "main" });
  assert.match(relay.snippet, /wrangler/);
});

test("archived Chats are searched only when asked, and come back marked", async (t) => {
  const projectPath = await savedProject(t, { 1: { id: 1, title: "Live" }, 2: { id: 2, title: "Old", archived: true } }, [
    message(1, 1, "nothing here"),
    message(2, 2, "the archived needle"),
  ]);
  const search = searchOver([projectPath]);
  assert.deepEqual((await search.search("needle")).matches, []);
  const [found] = (await search.search("needle", { archived: true })).matches;
  assert.equal(found.chat.archived, true);
  assert.equal(found.chat.title, "Old");
});

test("a deleted Chat's leftover rows never match, and a Chat gives at most perChat matches", async (t) => {
  const projectPath = await savedProject(t, { 1: { id: 1, title: "Kept" } }, [
    message(1, 1, "needle one"),
    message(2, 1, "needle two"),
    message(3, 1, "needle three"),
    message(4, 7, "needle in a deleted Chat"),
  ]);
  const { matches } = await searchOver([projectPath]).search("needle", { perChat: 2 });
  assert.deepEqual(
    matches.map((match) => match.message.id),
    [3, 2],
  );
});

test("one Chat with hundreds of higher-ranked matches leaves room for another matching Chat", async (t) => {
  const projectPath = await savedProject(t, { 1: { id: 1, title: "Busy" }, 2: { id: 2, title: "Quiet" } }, [
    ...Array.from({ length: 201 }, (_, index) => message(index + 1, 1, "needle")),
    message(202, 2, "needles"),
  ]);
  const { matches } = await searchOver([projectPath]).search("needle", { limit: 4, perChat: 3 });
  assert.deepEqual(
    matches.map((hit) => hit.message.id),
    [201, 200, 199, 202],
  );
});

test("a Project that can't be read is reported, the others still answer, and a Project without Chats is skipped", async (t) => {
  const good = await savedProject(t, { 1: { id: 1, title: "Fine" } }, [message(1, 1, "needle")]);
  const broken = await savedProject(t, { 1: { id: 1 } }, [message(1, 1, "needle")]);
  fs.rmSync(path.join(broken, ".milagre", "chats.db"));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-search-empty-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const { matches, failed, searched } = await searchOver([good, broken, empty]).search("needle");
  assert.equal(matches.length, 1);
  assert.equal(searched, 1);
  assert.deepEqual(
    failed.map((item) => [item.projectPath, item.error]),
    [[broken, "Its messages file (.milagre/chats.db) is missing."]],
  );
});

test("a Project saved in the older inline format is searched too", async (t) => {
  const projectPath = await savedProject(t, { 1: { id: 1, title: "Old format" } }, [message(1, 1, "inline needle")], { inline: true });
  assert.equal((await searchOver([projectPath]).search("needle")).matches[0].chat.title, "Old format");
});

test("a saved Project changed since the last search is read again", async (t) => {
  const projectPath = await savedProject(t, { 1: { id: 1, title: "Before" } }, [message(1, 1, "first needle")]);
  const search = searchOver([projectPath]);
  assert.equal((await search.search("needle")).matches.length, 1);
  await writeMessages(projectPath, [message(1, 1, "first needle"), message(2, 1, "second needle")], new Map());
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(projectPath, ".milagre", "chats.db"), future, future);
  assert.equal((await search.search("needle")).matches.length, 2);
});

test("one scope answers alone and throws its read error instead of listing it", async (t) => {
  const projectPath = await savedProject(t, { 1: { id: 1 } }, [message(1, 1, "needle")]);
  fs.rmSync(path.join(projectPath, ".milagre", "chats.db"));
  await assert.rejects(searchOver([]).search("needle", { scope: projectPath }), /chats\.db\) is missing/);
});

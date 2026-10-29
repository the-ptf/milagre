const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { NOT_A_CHAT_FOLDER, registerGitHandlers } = require("./git-ipc.cjs");

function register(overrides = {}) {
  const handlers = new Map();
  const calls = [];
  const record = (name, result) => async (request) => {
    calls.push({ name, request });
    return result;
  };
  const actions = {
    readChanges: record("readChanges", { isRepo: true }),
    readTextContext: record("readTextContext", {
      diff: "+new\n",
      recentSubjects: ["fix: a"],
      branchCommits: [],
      branch: "milagre/x",
      base: "main",
      hasChanges: true,
    }),
    commit: record("commit", { ok: true, sha: "abc", shortSha: "abc" }),
    push: record("push", { ok: true, branch: "milagre/x", remote: "origin" }),
    openPr: record("openPr", { ok: true, url: "https://github.com/a/b/pull/1", number: 1 }),
  };
  const diff = {
    history: record("history", { isRepo: true, branch: "feature", base: "main", branches: [], commits: [], hasMore: false }),
    listDiffFiles: record("listDiffFiles", { isRepo: true, base: "main", files: [] }),
    readDiffFile: record("readDiffFile", { patch: "", binary: false, tooLarge: false }),
  };
  const prompts = [];
  const models = {
    claude: async ({ prompt }) => {
      prompts.push(prompt);
      return '{"commitMessage":"fix: x","prTitle":"Fix x","prBody":"Fixes x."}';
    },
    codex: null,
  };
  registerGitHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    { cli: async () => ({ command: null, problem: "missing" }), actions, diff, models, ...overrides },
  );
  const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
  return { handlers, calls, invoke, prompts };
}

test("the dialog's channels reach the git actions", async () => {
  const { handlers, calls, invoke } = register();
  assert.deepEqual([...handlers.keys()].filter((channel) => channel.startsWith("git:")).sort(), [
    "git:changes",
    "git:commit",
    "git:diff-file",
    "git:diff-files",
    "git:generate",
    "git:history",
    "git:open-pr",
    "git:push",
  ]);
  await invoke("git:changes", { cwd: "/repo/wt", base: "main" });
  await invoke("git:commit", { cwd: "/repo/wt", message: "fix: x" });
  await invoke("git:push", { cwd: "/repo/wt" });
  await invoke("git:open-pr", { cwd: "/repo/wt", base: "main", title: "Fix x", body: "Fixes x." });
  await invoke("git:history", { cwd: "/repo/wt", base: "main", recordedBase: "parent", branchesVersion: "catalogue-v1", limit: 30 });
  await invoke("git:diff-files", { cwd: "/repo/wt", base: "main", mode: "committed" });
  await invoke("git:diff-file", { cwd: "/repo/wt", base: "main", mode: "uncommitted", path: "a.ts", oldPath: "b.ts", untracked: false });
  assert.deepEqual(calls, [
    { name: "readChanges", request: { cwd: "/repo/wt", base: "main" } },
    { name: "commit", request: { cwd: "/repo/wt", message: "fix: x" } },
    { name: "push", request: { cwd: "/repo/wt" } },
    { name: "openPr", request: { cwd: "/repo/wt", base: "main", title: "Fix x", body: "Fixes x." } },
    { name: "history", request: { cwd: "/repo/wt", base: "main", recordedBase: "parent", branchesVersion: "catalogue-v1", limit: 30 } },
    { name: "listDiffFiles", request: { cwd: "/repo/wt", base: "main", mode: "committed", commit: undefined } },
    {
      name: "readDiffFile",
      request: { cwd: "/repo/wt", base: "main", mode: "uncommitted", commit: undefined, path: "a.ts", oldPath: "b.ts", untracked: false },
    },
  ]);
});

test("git:generate writes from the chat and the folder's diff", async () => {
  const { invoke, prompts } = register();
  const result = await invoke("git:generate", {
    cwd: "/repo/wt",
    base: "main",
    provider: "claude",
    chat: { chatTitle: "Fix x", firstMessage: "Please fix x", recentMessages: [], testCommands: [] },
  });
  assert.deepEqual(result, { ok: true, provider: "claude", commitMessage: "fix: x", prTitle: "Fix x", prBody: "Fixes x." });
  assert.match(prompts[0], /Please fix x/);
  assert.match(prompts[0], /\+new/);
  assert.match(prompts[0], /fix: a/);
});

test("the channels refuse a folder that isn't an absolute path", async () => {
  const { invoke } = register();
  await assert.rejects(async () => invoke("git:commit", { cwd: "relative/path", message: "x" }), /folder/);
  await assert.rejects(async () => invoke("git:changes", { cwd: 42 }), /folder/);
});

test("the channels wait for the login environment before running git or gh", async () => {
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, invoke } = register({ ready: () => ready });
  const pending = invoke("git:push", { cwd: "/repo/wt" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
  release();
  await pending;
  assert.deepEqual(calls, [{ name: "push", request: { cwd: "/repo/wt" } }]);
});

test("the channels only act in a chat's known folder", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-ipc-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chat = path.join(root, "chat");
  const elsewhere = path.join(root, "elsewhere");
  await fs.mkdir(chat);
  await fs.mkdir(elsewhere);
  const { calls, invoke } = register({ knownFolders: async () => [chat] });
  // The same folder through a symlinked path is still the chat's.
  await fs.symlink(chat, path.join(root, "link"));
  await invoke("git:commit", { cwd: path.join(root, "link"), message: "fix: x" });
  assert.equal(calls.length, 1);
  for (const channel of ["git:changes", "git:generate", "git:commit", "git:push", "git:open-pr", "git:diff-files", "git:diff-file", "git:history"]) {
    await assert.rejects(async () => invoke(channel, { cwd: elsewhere, message: "x", title: "x", body: "" }), new RegExp(NOT_A_CHAT_FOLDER));
  }
  assert.equal(calls.length, 1);
});

test("the PR channels reach the review in the Chat's folder, and only there", async () => {
  const seen = [];
  const review = new Proxy({}, { get: (_target, name) => async (request) => (seen.push({ name, request }), { ok: true }) });
  const { invoke } = register({ review, knownFolders: async () => [] });
  await assert.rejects(invoke("pr:detail", { cwd: "/repo/wt", number: 1 }), new RegExp(NOT_A_CHAT_FOLDER.replace(/[.']/g, "\\$&")));
  assert.deepEqual(seen, []);

  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "pr-ipc-"));
  const allowed = register({ review, knownFolders: async () => [folder] });
  await allowed.invoke("pr:detail", { cwd: folder, number: 7 });
  await allowed.invoke("pr:merge", { cwd: folder, number: 7, method: "squash", auto: true });
  await allowed.invoke("pr:set-labels", { cwd: folder, number: 7, add: ["bug"], remove: [] });
  await allowed.invoke("pr:request-reviewers", { cwd: folder, number: 7, add: [], remove: ["octo"] });
  await allowed.invoke("pr:labels", { cwd: folder });
  assert.deepEqual(
    seen.map(({ name, request }) => [name, request.cwd, request.number]),
    [
      ["detail", folder, 7],
      ["merge", folder, 7],
      ["setLabels", folder, 7],
      ["requestReviewers", folder, 7],
      ["labels", folder, undefined],
    ],
  );
  assert.equal(seen[1].request.auto, true);
  assert.deepEqual(seen[2].request.add, ["bug"]);
  assert.deepEqual(seen[3].request.remove, ["octo"]);
  await fs.rm(folder, { recursive: true, force: true });
});

test("commit inspection forwards the SHA through the confined Git handlers", async () => {
  const { invoke, calls } = register();
  const commit = "a".repeat(40);
  await invoke("git:diff-files", { cwd: "/repo/wt", mode: "committed", commit });
  await invoke("git:diff-file", { cwd: "/repo/wt", mode: "committed", commit, path: "a.ts" });
  assert.equal(calls[0].request.commit, commit);
  assert.equal(calls[1].request.commit, commit);
});

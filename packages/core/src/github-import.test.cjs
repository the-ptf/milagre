const assert = require("node:assert/strict");
const test = require("node:test");
const { createGitHubImporter } = require("./github-import.cjs");

const issue = {
  repository: "acme/app",
  number: 12,
  url: "https://github.com/acme/app/issues/12",
  title: "Current title",
  body: "Author's body",
  state: "OPEN",
  importedAt: "2026-11-02T23:00:00Z",
  account: "victor",
};
const request = {
  projectPath: "/project",
  url: issue.url,
  account: "victor",
  target: { kind: "worktree", baseBranch: "main" },
  options: { clientMessageId: "unique-import-id-1234", provider: "codex", model: "test", permissionMode: "ask" },
  note: "User's note",
};
function fixture({ failure } = {}) {
  const calls = [];
  const project = { path: "/project", state: { worktrees: { 1: { id: 1, path: "/project" } }, sessions: { 2: { id: 2, worktree_id: 1 } } } };
  const importIssue = createGitHubImporter({
    issues: {
      read: async (...args) => {
        calls.push(["read", ...args]);
        if (failure) throw new Error(failure);
        return issue;
      },
    },
    readProject: async () => project,
    createWorktree: async (value) => {
      calls.push(["create", value]);
      return { worktreeId: 3, project: { state: { sessions: { 4: { id: 4, worktree_id: 3 } } } } };
    },
    send: async (value) => {
      calls.push(["send", value]);
      return { sessionId: value.sessionId ?? 5 };
    },
  });
  return { importIssue, calls };
}

test("confirmation creates once and uses the authoritative issue and chosen base", async () => {
  const { importIssue, calls } = fixture();
  const [first, retry] = await Promise.all([importIssue(request), importIssue(request)]);
  assert.deepEqual(first, retry);
  assert.equal(calls.filter(([kind]) => kind === "create").length, 1);
  assert.equal(calls.find(([kind]) => kind === "create")[1].baseBranch, "main");
  const send = calls.find(([kind]) => kind === "send")[1];
  assert.equal(send.sessionId, 4, "reuse the initial Chat created with the Worktree");
  assert.match(send.body, /Current title/);
  assert.deepEqual(send.githubIssue, { url: issue.url, account: "victor", note: "User's note" });
  await assert.rejects(importIssue({ ...request, note: "Another request" }), /already used/);
});

test("existing Chat or new Chat in a Worktree uses the selected target without creating a Worktree", async () => {
  for (const target of [
    { kind: "existing", sessionId: 2 },
    { kind: "chat", worktreeId: 1 },
  ]) {
    const { importIssue, calls } = fixture();
    await importIssue({ ...request, target });
    assert.ok(!calls.some(([kind]) => kind === "create"));
    const send = calls.find(([kind]) => kind === "send")[1];
    assert.equal(send.worktreeId, 1);
    assert.equal(send.sessionId, target.kind === "existing" ? 2 : null);
  }
});

test("permission/state failures and unavailable targets create no work or send", async () => {
  for (const failure of ["No access", "Issue deleted", "Issue closed", "Account changed"]) {
    const { importIssue, calls } = fixture({ failure });
    await assert.rejects(importIssue(request), new RegExp(failure));
    assert.ok(!calls.some(([kind]) => kind === "create" || kind === "send"));
  }
  for (const target of [
    { kind: "existing", sessionId: 99 },
    { kind: "chat", worktreeId: 99 },
    { kind: "worktree", baseBranch: "" },
  ]) {
    const { importIssue, calls } = fixture();
    await assert.rejects(importIssue({ ...request, target }));
    assert.equal(calls.length, 0);
  }
});

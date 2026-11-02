const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createGitHubImporter } = require("./github-import.cjs");
const { createGitHubImportStore } = require("./github-import-store.cjs");

async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "github-import-receipts-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const project = { state: { worktrees: { 1: { id: 1 } }, sessions: { 2: { id: 2, worktree_id: 1 } } } };
  const issue = { repository: "acme/app", number: 12, url: "https://github.com/acme/app/issues/12", account: "test", title: "Issue" };
  const request = {
    projectPath: "/p",
    url: issue.url,
    account: "test",
    target: { kind: "worktree", baseBranch: "main" },
    options: { clientMessageId: "restart-request-1234", provider: "codex", model: "test", permissionMode: "ask" },
  };
  let validBase = false;
  let creates = 0,
    sends = 0,
    failSend = false,
    uncertainCreate = false;
  const restart = () =>
    createGitHubImporter({
      store: createGitHubImportStore(folder),
      validateBase: async (_path, branch) => {
        if (validBase && branch !== "main") throw new Error("Choose an existing base branch");
      },
      readProject: async () => project,
      issues: { read: async () => issue },
      createWorktree: async () => {
        creates++;
        if (uncertainCreate) throw new Error("Connection closed during creation");
        project.state.worktrees[3] = { id: 3 };
        project.state.sessions[4] = { id: 4, worktree_id: 3 };
        return { project, worktreeId: 3 };
      },
      send: async () => {
        sends++;
        if (failSend) throw new Error("GitHub temporarily unavailable");
        return { sessionId: 4 };
      },
    });
  return {
    folder,
    validateBase: () => {
      validBase = true;
    },
    request,
    restart,
    counts: () => ({ creates, sends }),
    failSend: (value) => {
      failSend = value;
    },
    uncertain: () => {
      uncertainCreate = true;
    },
  };
}

test("a failed send retries after a host restart in the same created Worktree, and an accepted import is not sent twice", async (t) => {
  const f = await fixture(t);
  f.failSend(true);
  await assert.rejects(f.restart()(f.request), /temporarily unavailable/);
  f.failSend(false);
  const result = await f.restart()(f.request);
  assert.equal(result.worktreeId, 3);
  assert.equal(result.sessionId, 4);
  await f.restart()(f.request);
  assert.deepEqual(f.counts(), { creates: 1, sends: 2 });
  const files = await fs.readdir(path.join(f.folder, "github-imports"));
  assert.equal(files.length, 1);
  const receipt = JSON.parse(await fs.readFile(path.join(f.folder, "github-imports", files[0]), "utf8"));
  assert.deepEqual(Object.keys(receipt).sort(), ["phase", "sessionId", "signature", "worktreeId"]);
});

test("a restart after uncertain creation refuses to make a second Worktree", async (t) => {
  const f = await fixture(t);
  f.uncertain();
  await assert.rejects(f.restart()(f.request), /Connection closed/);
  await assert.rejects(f.restart()(f.request), /creation was interrupted/);
  assert.deepEqual(f.counts(), { creates: 1, sends: 0 });
});

test("a rejected base branch reserves nothing, so it can be corrected within the same import", async (t) => {
  const f = await fixture(t);
  f.validateBase();
  await assert.rejects(f.restart()({ ...f.request, target: { kind: "worktree", baseBranch: "invalid" } }), /existing base branch/);
  const result = await f.restart()(f.request);
  assert.equal(result.worktreeId, 3);
  assert.deepEqual(f.counts(), { creates: 1, sends: 1 });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const lib = await import("./link-scope.ts").catch(() => null);
test("Link drafts have their own scope and remember a Chat independently", () => {
  assert.ok(lib);
  const drafts = lib.createScopeDrafts();
  const project = { kind: "project" as const, projectPath: "/api" };
  const link = { kind: "link" as const, linkId: randomUUID() };
  drafts.save(project, { text: "Project", sessionId: 2 });
  drafts.save(link, { text: "Both", sessionId: 4 });
  assert.deepEqual(drafts.read(project), { text: "Project", sessionId: 2 });
  assert.deepEqual(drafts.read(link), { text: "Both", sessionId: 4 });
});
test("Git member choice resolves stable Project IDs and rejects unrelated members", () => {
  assert.ok(lib);
  const state = {
    next_id: 2,
    preparations: {},
    messages: [],
    sessions: {
      1: {
        id: 1,
        agent_name: "Link",
        status: "Created" as const,
        workspacePath: "/workspace",
        worktrees: [
          { projectId: "api", projectPath: "/api", worktreePath: "/work/api", branch: "feature", base: "main" },
          { projectId: "web", projectPath: "/web", worktreePath: "/work/web", branch: "feature", base: "main" },
        ],
      },
    },
  };
  assert.equal(lib.memberWorktreeForAction(state, 1, "web").worktreePath, "/work/web");
  assert.throws(() => lib.memberWorktreeForAction(state, 1, "other"), /member/);
});
test("a pending send keeps its identity across scope navigation and clears after acknowledgement", () => {
  assert.ok(lib);
  const drafts = lib.createScopeDrafts();
  const link = { kind: "link" as const, linkId: randomUUID() };
  const first = drafts.beginSend(link, null, "Edit both");
  drafts.save(link, { text: "Edit both", sessionId: null });
  assert.equal(drafts.beginSend(link, null, "Edit both"), first);
  assert.notEqual(drafts.beginSend(link, null, "Different draft"), first);
  drafts.acknowledgeSend(first);
  assert.notEqual(drafts.beginSend(link, null, "Edit both"), first);
});
test("an explicit new Chat draft remains selected after the daemon allocates its first Chat", () => {
  assert.ok(lib);
  const drafts = lib.createScopeDrafts();
  const link = { kind: "link" as const, linkId: randomUUID() };
  assert.equal(drafts.has(link), false);
  drafts.save(link, { text: "Retry this first message", sessionId: null });
  assert.equal(drafts.has(link), true);
  assert.equal(drafts.read(link).sessionId, null);
});
test("acknowledgement reconciles a saved first-send draft but keeps newer edits", () => {
  assert.ok(lib);
  const drafts = lib.createScopeDrafts();
  const link = { kind: "link" as const, linkId: randomUUID() };
  const operation = drafts.beginSend(link, null, JSON.stringify({ body: "Edit both" }));
  drafts.save(link, { text: "Edit both", sessionId: null });
  drafts.acknowledgeSend(operation, 7);
  assert.deepEqual(drafts.read(link), { text: "", sessionId: 7 });
  const next = drafts.beginSend(link, null, JSON.stringify({ body: "Another Chat" }));
  drafts.save(link, { text: "A newer draft", sessionId: null });
  drafts.acknowledgeSend(next, 8);
  assert.deepEqual(drafts.read(link), { text: "A newer draft", sessionId: null });
});
test("choosing New Chat creates a new draft identity even with identical text", () => {
  assert.ok(lib);
  const drafts = lib.createScopeDrafts();
  const link = { kind: "link" as const, linkId: randomUUID() };
  const operation = drafts.beginSend(link, null, "Run tests");
  drafts.newSelection(link);
  drafts.save(link, { text: "Run tests", sessionId: null });
  assert.notEqual(drafts.beginSend(link, null, "Run tests"), operation);
  drafts.acknowledgeSend(operation, 7);
  assert.deepEqual(drafts.read(link), { text: "Run tests", sessionId: null });
});

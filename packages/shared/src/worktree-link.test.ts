import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, WorktreeLinkedContext } from "./model.ts";
import { summarizeChat } from "./chat-summary.mjs";
import { deletedLinkText, deleteLinkText, linkedSummaryText, linkRunningText, worktreeLinkLabel, worktreeLinkText } from "./worktree-link.mjs";

const line = (extra: Partial<WorktreeLinkedContext>): WorktreeLinkedContext => ({
  kind: "worktree-linked",
  linkId: "l1",
  project: { name: "web", path: "/code/web" },
  sameProject: false,
  branches: ["main"],
  ...extra,
});

test("another Project's Worktree is named by Project and branch", () => {
  assert.deepEqual(worktreeLinkLabel(line({})), { lead: null, project: "web", detail: "main" });
  assert.equal(worktreeLinkText(line({})), "Linked to web main");
});

test("a whole-Project Link names how many Worktrees it reached", () => {
  const context = line({ project: { name: "mobile", path: "/code/mobile" }, branches: ["main", "upload-sheet", "fix"] });
  assert.deepEqual(worktreeLinkLabel(context), { lead: null, project: "mobile", detail: "· 3 Worktrees" });
});

test("a Worktree of the Chat's own Project is named by its branch", () => {
  const context = line({ project: { name: "api", path: "/code/api" }, sameProject: true, branches: ["upload-retries"] });
  assert.deepEqual(worktreeLinkLabel(context), { lead: "Worktree", project: null, detail: "upload-retries" });
  assert.equal(worktreeLinkText(context), "Linked to Worktree upload-retries in this Project");
});

test("the summary opens without the tags that wrap it for the agent", () => {
  assert.equal(linkedSummaryText("<linked_worktrees>\nMilagre attached this.\n\n## web\n</linked_worktrees>"), "Milagre attached this.\n\n## web");
});

test("a link line is not the Chat's last reply", () => {
  const messages: ChatMessage[] = [
    { id: 1, session_id: 1, body: "hi", context: null, role: "user" },
    { id: 2, session_id: 1, body: "done", context: null, role: "assistant", outcome: "completed" },
    { id: 3, session_id: 1, body: "Linked to web main", context: line({}), role: "assistant" },
  ];
  assert.equal(summarizeChat(messages).lastOutcome, "completed");
});

test("deleting a Link says how many Chats it archives and which Worktrees stay", () => {
  assert.equal(deleteLinkText("Food", 0).message.split(". ")[0], "It has no Chats");
  assert.match(deleteLinkText("Food", 1).message, /^Its Chat is archived, and its transcript stays on disk\. /);
  const many = deleteLinkText("Food", 3);
  assert.equal(many.title, "Delete Food?");
  assert.equal(many.action, "Delete Link");
  assert.match(many.message, /^Its 3 Chats are archived, and their transcripts stay on disk\. Worktrees without changes are removed\. /);
});

test("a running Chat holds the delete, named by its title", () => {
  assert.equal(linkRunningText(["Fix header"]), "Fix header is running. Stop it before deleting the Link.");
  assert.equal(linkRunningText(["A", "B", "C"]), "A, B and C are running. Stop them before deleting the Link.");
});

test("after a delete, the kept Worktrees are listed, and nothing is said when none were", () => {
  assert.equal(deletedLinkText("Food", []), null);
  assert.equal(deletedLinkText("Food", ["/w/web/fix"]), "Deleted Food. 1 Worktree with changes stays in its Project: /w/web/fix");
  assert.equal(deletedLinkText("Food", ["/w/a", "/w/b"]), "Deleted Food. 2 Worktrees with changes stay in their Projects: /w/a, /w/b");
});

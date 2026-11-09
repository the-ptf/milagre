import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, WorktreeLinkedContext } from "./model.ts";
import { summarizeChat } from "./chat-summary.mjs";
import {
  deletedLinkText,
  deleteLinkText,
  isDeletedLinkState,
  isLinkGone,
  linkDeletedElsewhereText,
  linkDeleteFailure,
  linkedSummaryText,
  linkRunningText,
  worktreeLinkLabel,
  worktreeLinkText,
} from "./worktree-link.mjs";

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

test("a computer too old to delete Links is asked to update, named on desktop and as your Mac on the phone", () => {
  for (const refusal of ["Command is not available from mobile", "Unknown command: link:delete", "No handler registered for 'link:delete-check'"]) {
    assert.equal(linkDeleteFailure(refusal, { computer: "Studio" }), "Update Milagre on Studio to delete its Links.");
    assert.equal(linkDeleteFailure(refusal, { computer: "this Mac" }), "Update Milagre on this Mac to delete its Links.");
    assert.equal(linkDeleteFailure(refusal), "Update Milagre on your Mac to delete Links from your phone.");
  }
  assert.equal(
    linkDeleteFailure("Fix header is running. Stop it before deleting the Link.", { computer: "Studio" }),
    "Fix header is running. Stop it before deleting the Link.",
  );
  assert.equal(linkDeleteFailure("Link no longer exists"), "Link no longer exists");
});

test("a Link deleted elsewhere is told by its marked state or by a refused read", () => {
  assert.equal(isDeletedLinkState({ sessions: {}, deletedAt: "2026-11-02T14:00:00.000Z" }), true);
  assert.equal(isDeletedLinkState({ sessions: {} }), false);
  assert.equal(isDeletedLinkState(null), false);
  assert.equal(isLinkGone("Error invoking remote method 'link:open': Error: Link no longer exists"), true);
  assert.equal(isLinkGone("This Link is being deleted"), false);
  assert.equal(linkDeletedElsewhereText("Food"), "Food was deleted on another device.");
});

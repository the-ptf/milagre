import assert from "node:assert/strict";
import test from "node:test";
import { confirmLinkDelete, linkDeleteError } from "./link-delete.ts";

const answering =
  (check: { chats: number; running: string[] }) =>
  async <T>(method: string, args: unknown[] = []) => {
    assert.equal(method, "link:delete-check");
    assert.deepEqual(args, ["link-1"]);
    return check as T;
  };

test("the phone asks with the Link's Chat count and the desktop's words", async () => {
  const asked: string[][] = [];
  const confirmed = await confirmLinkDelete(answering({ chats: 2, running: [] }), "link-1", "Food", async (...question) => {
    asked.push(question.map(String));
    return true;
  });
  assert.equal(confirmed, true);
  const [title = "", message = "", action = ""] = asked[0] ?? [];
  assert.equal(title, "Delete Food?");
  assert.match(message, /^Its 2 Chats are archived/);
  assert.equal(action, "Delete Link");
});

test("a running Chat holds the delete before anything is asked", async () => {
  let asked = false;
  await assert.rejects(
    confirmLinkDelete(answering({ chats: 1, running: ["Fix header"] }), "link-1", "Food", async () => (asked = true)),
    /^Error: Fix header is running\. Stop it before deleting the Link\.$/,
  );
  assert.equal(asked, false);
});

test("an older Mac that can't delete Links from a phone is asked to update", () => {
  assert.equal(linkDeleteError(new Error("Command is not available from mobile")), "Update Milagre on your Mac to delete Links from your phone.");
  // A Mac routing the phone's call to another computer that lacks it.
  assert.equal(linkDeleteError(new Error("Unknown command: link:delete")), "Update Milagre on your Mac to delete Links from your phone.");
  assert.equal(linkDeleteError(new Error("Link no longer exists")), "Link no longer exists");
});

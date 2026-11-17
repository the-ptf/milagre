import assert from "node:assert/strict";
import test from "node:test";
import { CHATS_GROUP_KEY, isChatsHomeProject } from "./chats-home.mjs";

test("only a Project of kind chats is the Chats home", () => {
  assert.equal(isChatsHomeProject({ kind: "chats" }), true);
  assert.equal(isChatsHomeProject({}), false);
  assert.equal(isChatsHomeProject({ kind: "other" }), false);
  assert.equal(isChatsHomeProject(null), false);
  assert.equal(isChatsHomeProject(undefined), false);
});

test("the group key can never be a path", () => {
  assert.equal(CHATS_GROUP_KEY, "milagre-chats");
  assert.ok(!CHATS_GROUP_KEY.includes("/"));
});

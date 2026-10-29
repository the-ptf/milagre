import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_CHATS_LABEL,
  CHATS_ACCOUNT_DETAIL,
  CHATS_ACCOUNT_LABEL,
  CHATS_GROUP_KEY,
  CHATS_GROUP_LABEL,
  CHATS_PLACEHOLDER,
  CHATS_TRAY_LABEL,
  JUST_CHAT_HEADING,
  NO_PROJECT_FOLDER,
  NO_PROJECT_LABEL,
  NO_PROJECT_LINE,
  isChatsHomeProject,
} from "./chats-home.mjs";

test("only a Project of kind chats is the Chats home", () => {
  assert.equal(isChatsHomeProject({ kind: "chats" }), true);
  assert.equal(isChatsHomeProject({}), false);
  assert.equal(isChatsHomeProject({ kind: "other" }), false);
  assert.equal(isChatsHomeProject(null), false);
  assert.equal(isChatsHomeProject(undefined), false);
});

test("the group key can never be a path and the labels are the ones the screens show", () => {
  assert.equal(CHATS_GROUP_KEY, "milagre-chats");
  assert.ok(!CHATS_GROUP_KEY.includes("/"));
  assert.deepEqual(
    [NO_PROJECT_LABEL, CHATS_GROUP_LABEL, ALL_CHATS_LABEL, CHATS_ACCOUNT_LABEL, CHATS_ACCOUNT_DETAIL],
    ["No project", "Chats", "All chats", "Chats without a Project", "Every quick chat on this computer"],
  );
});

test("a new Chat without a Project says the same on desktop and phone", () => {
  assert.deepEqual(
    [JUST_CHAT_HEADING, CHATS_TRAY_LABEL, CHATS_PLACEHOLDER, NO_PROJECT_FOLDER, NO_PROJECT_LINE],
    ["Just chat", "Yapping around", "Ask anything", "Its own empty folder", "No project · its own empty folder"],
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpenChat, requestNavigation, subscribeNavigation, takeNavigation } from "./navigation-commands.ts";

test("a request is taken once and announced to the lists on screen", () => {
  let calls = 0;
  const stop = subscribeNavigation(() => calls++);
  requestNavigation({ kind: "chat", index: 2 });
  assert.equal(calls, 1);
  assert.deepEqual(takeNavigation(), { kind: "chat", index: 2 });
  assert.equal(takeNavigation(), null, "a second list finds nothing left");
  stop();
});

test("a request nothing picked up in time is dropped", () => {
  requestNavigation({ kind: "new" });
  assert.equal(takeNavigation(Date.now() + 5000), null);
});

test("only a link to the Chat already open, on its computer and Project, counts as open", () => {
  const open = { hostId: "http://mac", projectPath: "/p", chatId: 4 };
  const href = (params: Record<string, string>) => ({ pathname: "/chat", params });
  assert.equal(isOpenChat(href({ hostId: "http://mac", projectPath: "/p", id: "4" }), open), true);
  assert.equal(isOpenChat(href({ hostId: "http://mac", projectPath: "/p", id: "5" }), open), false, "another Chat");
  assert.equal(isOpenChat(href({ hostId: "http://studio", projectPath: "/p", id: "4" }), open), false, "same id on another computer");
  assert.equal(isOpenChat(href({ hostId: "http://mac", projectPath: "/p", worktreeId: "1" }), open), false, "a new Chat");
  assert.equal(isOpenChat("/routines", open), false);
  assert.equal(isOpenChat(href({ hostId: "http://mac", projectPath: "/p", id: "4" }), { ...open, chatId: undefined }), false, "nothing open");
});

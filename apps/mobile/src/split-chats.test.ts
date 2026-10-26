import { test } from "node:test";
import assert from "node:assert/strict";
import { besideChat, besideState, canOpenBeside, closeBeside, openBeside } from "./split-chats.ts";

const open = { wide: true, hostId: "mac", projectPath: "/p", chatId: 1 };
const row = { hostId: "mac", projectPath: "/p", chatId: 2 };

test("Open beside is offered for another Chat of the open Project in a wide window", () => {
  assert.equal(canOpenBeside(row, open, null), true);
  assert.equal(canOpenBeside(row, { ...open, wide: false }, null), false, "narrow window");
  assert.equal(canOpenBeside({ ...row, chatId: 1 }, open, null), false, "the open Chat itself");
  assert.equal(canOpenBeside({ ...row, projectPath: "/other" }, open, null), false, "another Project");
  assert.equal(canOpenBeside({ ...row, hostId: "studio" }, open, null), false, "another computer");
  assert.equal(canOpenBeside(row, { ...open, chatId: undefined }, null), false, "no Chat open");
  assert.equal(canOpenBeside({ ...row, archived: true }, open, null), false, "archived");
  assert.equal(canOpenBeside(row, open, { hostId: "mac", projectPath: "/p", chatId: 2 }), false, "already beside");
  assert.equal(canOpenBeside(row, open, { hostId: "mac", projectPath: "/p", chatId: 3 }), true, "replaces the one beside");
});

test("the Chat beside shows only while the window and the open Project can hold it", () => {
  const beside = { hostId: "mac", projectPath: "/p", chatId: 2 };
  const at = { ...open, loadedPath: "/p", exists: () => true };
  assert.equal(besideState(null, at), "hidden");
  assert.equal(besideState(beside, at), "shown");
  assert.equal(besideState(beside, { ...at, chatId: undefined }), "shown", "a New Chat keeps it beside");
  assert.equal(besideState(beside, { ...at, wide: false }), "hidden", "narrowing keeps it for later");
  assert.equal(besideState(beside, { ...at, loadedPath: "/loading" }), "hidden");
  assert.equal(besideState(beside, { ...at, hostId: undefined }), "hidden", "disconnected");
});

test("the pair ends when the routed Chat becomes it, leaves its Project or it is gone", () => {
  const beside = { hostId: "mac", projectPath: "/p", chatId: 2 };
  const at = { ...open, loadedPath: "/p", exists: () => true };
  assert.equal(besideState(beside, { ...at, chatId: 2 }), "ended");
  assert.equal(besideState(beside, { ...at, projectPath: "/other" }), "ended");
  assert.equal(besideState(beside, { ...at, hostId: "studio" }), "ended");
  assert.equal(besideState(beside, { ...at, exists: () => false }), "ended");
});

test("the store keeps one Chat beside until closed", () => {
  openBeside({ hostId: "mac", projectPath: "/p", chatId: 2 });
  openBeside({ hostId: "mac", projectPath: "/p", chatId: 3 });
  assert.equal(besideChat()?.chatId, 3);
  closeBeside();
  assert.equal(besideChat(), null);
});

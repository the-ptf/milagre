import { test } from "node:test";
import assert from "node:assert/strict";
import { besideChat, besideState, canOpenBeside, closeBeside, openBeside } from "./split-chats.ts";

const open = { wide: true, hostId: "mac", projectPath: "/p", chatId: 1 };
const row = { hostId: "mac", projectPath: "/p", chatId: 2 };

test("Open beside is offered for another Chat of any Project on any computer that answers, in a wide window", () => {
  assert.equal(canOpenBeside(row, open, null), true);
  assert.equal(canOpenBeside(row, { ...open, wide: false }, null), false, "narrow window");
  assert.equal(canOpenBeside({ ...row, chatId: 1 }, open, null), false, "the open Chat itself");
  assert.equal(canOpenBeside({ ...row, projectPath: "/other" }, open, null), true, "another Project");
  assert.equal(canOpenBeside({ ...row, projectPath: "/other", chatId: 1 }, open, null), true, "the same id in another Project");
  assert.equal(canOpenBeside({ ...row, hostId: "studio" }, open, null), true, "another computer");
  assert.equal(canOpenBeside({ ...row, hostId: "studio", chatId: 1 }, open, null), true, "the same id on another computer");
  assert.equal(canOpenBeside({ ...row, hostId: "studio", offline: true }, open, null), false, "a computer that doesn't answer");
  assert.equal(canOpenBeside(row, { ...open, chatId: undefined }, null), false, "no Chat open");
  assert.equal(canOpenBeside({ ...row, archived: true }, open, null), false, "archived");
  assert.equal(canOpenBeside(row, open, { hostId: "mac", projectPath: "/p", chatId: 2 }), false, "already beside");
  assert.equal(canOpenBeside(row, open, { hostId: "mac", projectPath: "/p", chatId: 3 }), true, "replaces the one beside");
});

test("the Chat beside shows only while the window can hold it and the open Project it shares is loaded", () => {
  const beside = { hostId: "mac", projectPath: "/p", chatId: 2 };
  const at = { ...open, loadedPath: "/p", exists: () => true };
  assert.equal(besideState(null, at), "hidden");
  assert.equal(besideState(beside, at), "shown");
  assert.equal(besideState(beside, { ...at, chatId: undefined }), "shown", "a New Chat keeps it beside");
  assert.equal(besideState(beside, { ...at, wide: false }), "hidden", "narrowing keeps it for later");
  assert.equal(besideState(beside, { ...at, loadedPath: "/loading" }), "hidden");
  assert.equal(besideState(beside, { ...at, hostId: undefined }), "hidden", "disconnected");
  // Another Project's Chat loads in its own pane: the routed one's Project loading has nothing to do with it.
  assert.equal(besideState(beside, { ...at, projectPath: "/other", loadedPath: "/loading" }), "shown", "routed Chat in another Project");
  assert.equal(besideState(beside, { ...at, hostId: "studio", loadedPath: undefined }), "shown", "routed Chat on another computer");
  assert.equal(besideState(beside, { ...at, projectPath: "/other", wide: false }), "hidden", "narrowing still keeps it");
});

test("the pair ends when the routed Chat becomes it or it is gone from the open Project, not when the routed one moves", () => {
  const beside = { hostId: "mac", projectPath: "/p", chatId: 2 };
  const at = { ...open, loadedPath: "/p", exists: () => true };
  assert.equal(besideState(beside, { ...at, chatId: 2 }), "ended");
  assert.equal(besideState(beside, { ...at, exists: () => false }), "ended");
  assert.equal(besideState(beside, { ...at, projectPath: "/other", loadedPath: "/other" }), "shown", "routed Chat moved to another Project");
  assert.equal(besideState(beside, { ...at, hostId: "studio" }), "shown", "routed Chat moved to another computer");
  assert.equal(besideState(beside, { ...at, projectPath: "/other", chatId: 2 }), "shown", "the same id in another Project is another Chat");
  // The open Project's list says nothing about a Chat of another Project: its own pane checks that.
  assert.equal(besideState(beside, { ...at, projectPath: "/other", exists: () => false }), "shown");
});

test("the store keeps one Chat beside until closed", () => {
  openBeside({ hostId: "mac", projectPath: "/p", chatId: 2 });
  openBeside({ hostId: "mac", projectPath: "/p", chatId: 3 });
  assert.equal(besideChat()?.chatId, 3);
  closeBeside();
  assert.equal(besideChat(), null);
});

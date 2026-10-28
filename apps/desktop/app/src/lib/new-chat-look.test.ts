import assert from "node:assert/strict";
import test from "node:test";
import { newChatLook } from "./new-chat-look.ts";

test('heading reads "Just chat" when the Chats home is picked', () => {
  assert.deepEqual(newChatLook("chats"), { heading: "Just chat", tray: "chats", trayLabel: "Yapping around", placeholder: "Ask anything" });
});

test("a Project's new Chat keeps its heading, chips and placeholder", () => {
  assert.deepEqual(newChatLook(undefined), { heading: "Start building in", tray: "project" });
});

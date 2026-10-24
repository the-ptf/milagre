import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_LIST_MODES, chatListLabel, parseChatList, parseToolCallDisplay } from "./chat-display.ts";

test("Tool call display keeps a saved choice and reads Murilo mode as Full detail", () => {
  assert.equal(parseToolCallDisplay("full"), "full");
  assert.equal(parseToolCallDisplay("compact", true), "compact", "a saved choice wins over the old switch");
  assert.equal(parseToolCallDisplay(undefined, true), "full");
  assert.equal(parseToolCallDisplay(undefined, false), "compact");
  assert.equal(parseToolCallDisplay("loud"), "compact");
});

test("Chat list reads a saved choice and falls back to One list", () => {
  assert.equal(parseChatList("grouped"), "grouped");
  assert.equal(parseChatList("list"), "list");
  assert.equal(parseChatList(undefined), "list");
  assert.equal(parseChatList("tabs"), "list");
  assert.equal(parseChatList(null), "list");
  assert.deepEqual(
    CHAT_LIST_MODES.map((mode) => mode.id),
    ["list", "grouped"],
  );
  assert.equal(chatListLabel("list"), "One list");
  assert.equal(chatListLabel("grouped"), "Grouped by Project");
});

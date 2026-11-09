import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_LIST_MODES, chatListLabel, compactButtonState, parseChatList, parseCompactButtonDisplay, parseToolCallDisplay } from "./chat-display.ts";

test("compact button preferences share the context warning threshold and respect provider support", () => {
  assert.equal(parseCompactButtonDisplay(undefined), "threshold");
  assert.equal(parseCompactButtonDisplay("invalid"), "threshold");
  assert.equal(parseCompactButtonDisplay("always"), "always");
  assert.deepEqual(compactButtonState("threshold", { used: 74, size: 100 }, true), { visible: false, warning: false });
  assert.deepEqual(compactButtonState("threshold", { used: 75, size: 100 }, true), { visible: true, warning: true });
  assert.deepEqual(compactButtonState("threshold", { used: 100, size: 100 }, false), { visible: false, warning: true });
  assert.deepEqual(compactButtonState("always", { used: 20, size: 100 }, true), { visible: true, warning: false });
  assert.deepEqual(compactButtonState("always", undefined, true), { visible: true, warning: false });
  assert.equal(compactButtonState("always", undefined, false).visible, false);
  assert.equal(compactButtonState("threshold", undefined, true).visible, false);
  assert.equal(compactButtonState("threshold", { used: 20, size: 0 }, true).visible, false);
});

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

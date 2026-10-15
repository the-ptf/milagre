import assert from "node:assert/strict";
import test from "node:test";
import { parseToolCallDisplay } from "./chat-display.ts";

test("Tool call display keeps a saved choice and reads Murilo mode as Full detail", () => {
  assert.equal(parseToolCallDisplay("full"), "full");
  assert.equal(parseToolCallDisplay("compact", true), "compact", "a saved choice wins over the old switch");
  assert.equal(parseToolCallDisplay(undefined, true), "full");
  assert.equal(parseToolCallDisplay(undefined, false), "compact");
  assert.equal(parseToolCallDisplay("loud"), "compact");
});

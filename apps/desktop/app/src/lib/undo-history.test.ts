import assert from "node:assert/strict";
import { test } from "node:test";
import { undoKey } from "./undo-history.ts";

test("⌘Z reaches the history only outside text fields and dialogs", () => {
  const key = (init: Partial<KeyboardEvent>) =>
    ({
      key: "z",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      isComposing: false,
      defaultPrevented: false,
      target: null,
      ...init,
    }) as KeyboardEvent;
  assert.equal(undoKey(key({ metaKey: true }), true), "undo");
  assert.equal(undoKey(key({ metaKey: true, shiftKey: true, key: "Z" }), true), "redo");
  assert.equal(undoKey(key({ ctrlKey: true }), true), null, "Ctrl+Z is not undo on a Mac");
  assert.equal(undoKey(key({ ctrlKey: true }), false), "undo");
  assert.equal(undoKey(key({ metaKey: true, altKey: true }), true), null);
  assert.equal(undoKey(key({ metaKey: true, defaultPrevented: true }), true), null, "an editor took it");
});

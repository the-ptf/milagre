import assert from "node:assert/strict";
import { test } from "node:test";
import { createUndoHistory } from "./undo-history.ts";

test("⌘Z walks back through the steps and ⇧⌘Z forward again, with the toast naming each one", () => {
  const history = createUndoHistory();
  const done = new Set<string>();
  const step = (id: string) => ({
    text: "Moved to Done",
    kind: "done" as const,
    undoneText: "Back in Chats",
    undo: () => done.delete(id),
    redo: () => done.add(id),
  });
  done.add("a");
  history.record(step("a"));
  done.add("b");
  history.record(step("b"));
  assert.deepEqual(history.toast(), { id: 2, text: "Moved to Done", kind: "done", button: "undo" });

  assert.equal(history.undo(), true);
  assert.deepEqual([...done], ["a"]);
  assert.equal(history.toast()?.text, "Back in Chats");
  assert.equal(history.toast()?.button, "redo");
  assert.equal(history.undo(), true);
  assert.deepEqual([...done], []);
  assert.equal(history.undo(), false, "nothing left to undo");

  assert.equal(history.redo(), true);
  assert.deepEqual([...done], ["a"]);
  assert.equal(history.toast()?.button, "undo");

  // A new step ends what could be redone.
  done.add("c");
  history.record(step("c"));
  assert.equal(history.redo(), false);
  assert.equal(history.canUndo(), true);
});

test("a deletion can only be undone inside its window, and a late undo says so", () => {
  let clock = 0;
  const history = createUndoHistory(() => clock);
  history.record({ text: "Pinned", undo: () => {} });
  history.record({ text: "Chat deleted", kind: "deleted", undo: () => true, undoWindowMs: 6000 });
  clock = 7000;
  // The expired deletion drops off, so ⌘Z undoes the pin before it.
  assert.equal(history.undo(), true);
  assert.equal(history.toast()?.text, "Undone");
  assert.equal(history.canUndo(), false);

  history.record({ text: "Chat deleted", undo: () => false, undoWindowMs: 6000 });
  assert.equal(history.undo(), true);
  assert.deepEqual(history.toast(), { id: 5, text: "Too late to undo that", button: null });
  assert.equal(history.canRedo(), false);
});

test("a notice leaves the history alone, and dismissing an older toast keeps the newer one", () => {
  const history = createUndoHistory();
  history.record({ text: "Link created", undo: () => {} });
  const first = history.toast()!.id;
  history.notify("Could not ask “Fix flaky test”");
  history.dismiss(first);
  assert.equal(history.toast()?.text, "Could not ask “Fix flaky test”");
  assert.equal(history.canUndo(), true);
});

test("a failed step drops out of the history and takes its toast with it", () => {
  const history = createUndoHistory();
  history.record({ text: "Pinned", undo: () => {} });
  const failed = { text: "Moved to Done", undo: () => {}, redo: () => {} };
  history.record(failed);
  history.drop(failed);
  assert.equal(history.toast(), null);
  assert.equal(history.undo(), true);
  assert.equal(history.toast()?.text, "Undone", "⌘Z went to the pin before it");
});

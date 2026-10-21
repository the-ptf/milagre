import assert from "node:assert/strict";
import test from "node:test";
import { chatOnScreen, keepsRoutinesView, runPaneRestore } from "./run-pane.ts";

test("keepsRoutinesView holds the view for the Run Chat being opened, by its whole chat key", () => {
  assert.equal(keepsRoutinesView("/code/a#7", "/code/a", 7), true);
  // The same id in another Project (a sidebar click there) opens in the Chat view.
  assert.equal(keepsRoutinesView("/code/a#7", "/code/b", 7), false);
  assert.equal(keepsRoutinesView("/code/a#7", "/code/a", 8), false);
  assert.equal(keepsRoutinesView(null, "/code/a", 7), false);
  assert.equal(keepsRoutinesView("/code/a#7", undefined, 7), false);
});

test("runPaneRestore brings back the Chat the Run Chat replaced, in this Project, a Link or another Project", () => {
  const saved = { projectPath: "/code/a", linkId: null, sessionId: 3, worktreeId: 1 };
  // The Run Chat was in the same Project.
  assert.deepEqual(runPaneRestore(saved, "/code/a#9", "/code/a#9", "/code/a"), { kind: "same", sessionId: 3, worktreeId: 1 });
  // The Run Chat was in another Project: the window switched to it, and switches back.
  assert.deepEqual(runPaneRestore(saved, "/code/b#9", "/code/b#9", "/code/b"), { kind: "project", projectPath: "/code/a", sessionId: 3 });
  assert.deepEqual(runPaneRestore({ ...saved, linkId: "l1" }, "/code/b#9", "/code/b#9", "/code/b"), { kind: "link", linkId: "l1", sessionId: 3 });
  // A new Chat draft (no session) comes back as one.
  assert.deepEqual(runPaneRestore({ ...saved, sessionId: null }, "/code/a#9", "/code/a#9", "/code/a"), { kind: "same", sessionId: null, worktreeId: 1 });
});

test("runPaneRestore leaves a Chat picked since the pane opened", () => {
  const saved = { projectPath: "/code/a", linkId: null, sessionId: 3, worktreeId: 1 };
  assert.equal(runPaneRestore(saved, "/code/a#9", "/code/a#4", "/code/a"), null);
  assert.equal(runPaneRestore(null, "/code/a#9", "/code/a#9", "/code/a"), null);
  assert.equal(runPaneRestore(saved, null, "/code/a#9", "/code/a"), null);
});

test("chatOnScreen counts a Run Chat open in the pane beside its Routine's page as the Chat on screen", () => {
  const at = { projectPath: "/code/a", sessionId: 9 };
  assert.equal(chatOnScreen({ view: "chat", runPane: null, ...at }), "/code/a#9");
  assert.equal(chatOnScreen({ view: "routines", runPane: "/code/a#9", ...at }), "/code/a#9");
  // The pane still opening another Chat, or no pane: nothing on screen.
  assert.equal(chatOnScreen({ view: "routines", runPane: "/code/a#4", ...at }), null);
  assert.equal(chatOnScreen({ view: "routines", runPane: null, ...at }), null);
  assert.equal(chatOnScreen({ view: "settings", runPane: "/code/a#9", ...at }), null);
  assert.equal(chatOnScreen({ view: "chat", runPane: null, projectPath: "/code/a", sessionId: null }), null);
});

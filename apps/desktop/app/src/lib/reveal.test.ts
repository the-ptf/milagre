import assert from "node:assert/strict";
import test from "node:test";
import { chatRevealPath, projectMenuActions } from "./reveal.ts";

const state = {
  worktrees: { 1: { path: "/p" }, 2: { path: "/w/feature" } },
  sessions: { 10: { worktree_id: 2 }, 11: { worktree_id: 1 }, 12: { worktree_id: 99 } },
};

test("a chat reveals its worktree", () => {
  assert.equal(chatRevealPath(state, 10, "/p"), "/w/feature");
});

test("a local chat reveals the project folder", () => {
  assert.equal(chatRevealPath(state, 11, "/p"), "/p");
  assert.equal(chatRevealPath(state, 12, "/p"), "/p");
  assert.equal(chatRevealPath(state, 404, "/p"), "/p");
  assert.equal(chatRevealPath(null, 10, "/p"), "/p");
});

test("project menu actions", () => {
  assert.deepEqual(
    projectMenuActions(true).map((a) => [a.key, a.label]),
    [
      ["reveal", "Reveal in Finder"],
      ["copy-path", "Copy path"],
      ["copy-name", "Copy name"],
      ["settings", "Project settings"],
    ],
  );
  assert.equal(projectMenuActions(false)[0].label, "Show in file manager");
});

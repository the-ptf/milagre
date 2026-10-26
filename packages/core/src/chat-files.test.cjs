const test = require("node:test");
const assert = require("node:assert/strict");
const { sharedFilePaths, chatFolder } = require("./chat-files.cjs");

test("assistant links share exact files, including relative, encoded and reference links", () => {
  const message = {
    role: "assistant",
    body: '[Report](</tmp/my report.md:12>) [Source](../export/code.ts#L3) [Notes][notes]\n\n[notes]: /tmp/notes.md "Notes"',
  };
  assert.deepEqual([...sharedFilePaths(message, "/repo")], ["/tmp/my report.md", "/export/code.ts", "/tmp/notes.md"]);
});

test("plain paths, code examples, user messages, images and web links do not grant file access", () => {
  const body =
    "/tmp/private.txt `[secret](/tmp/code.txt)`\n\n```md\n[secret](/tmp/fenced.txt)\n```\n\n![image](/tmp/image.png) [web](https://example.com) [file](file:///tmp/file.txt)";
  assert.deepEqual([...sharedFilePaths({ role: "assistant", body }, "/repo")], []);
  assert.deepEqual([...sharedFilePaths({ role: "user", body: "[secret](/tmp/private.txt)" }, "/repo")], []);
  assert.deepEqual([...sharedFilePaths({ role: "assistant", body: "", steps: [{ detail: "[secret](/tmp/private.txt)" }] }, "/repo")], []);
});

test("links resolve from a Project Chat's Worktree or a shared Chat's workspace", () => {
  const message = { session_id: 2 };
  const state = { sessions: { 2: { worktree_id: 3 } }, worktrees: { 3: { path: "/worktree" } } };
  assert.equal(chatFolder(state, message, "/project"), "/worktree");
  state.sessions[2].workspacePath = "/workspace";
  assert.equal(chatFolder(state, message, "/project"), "/workspace");
});

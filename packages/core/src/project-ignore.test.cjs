const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ensureProjectIgnore } = require("./project-ignore.cjs");
const { readProjectState, saveProjectState, stateFile } = require("./project-store.cjs");

test("a legacy full save cycle stays ignored and retains images, details and subagent transcripts", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-ignore-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  await fs.mkdir(path.join(project, ".milagre"));
  const transcript = [{ id: "child-message", kind: "message", text: "Reviewed the change" }];
  const detail = "Tool output\n".repeat(1000);
  const state = {
    next_id: 3,
    sessions: { 1: { id: 1, subagents: [{ id: "child", title: "Review", transcript }] } },
    messages: [
      {
        id: 2,
        session_id: 1,
        role: "assistant",
        body: "Saved reply",
        images: [
          {
            id: "image",
            name: "image.png",
            dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
          },
        ],
        steps: [{ id: "tool", kind: "shell", title: "Ran a command", status: "done", detail }],
      },
    ],
  };
  await fs.writeFile(stateFile(project), JSON.stringify(state));
  ensureProjectIgnore(project);
  await saveProjectState(project, state);
  for (const folder of ["images", "details", "subagents"]) assert.equal((await fs.readdir(path.join(project, ".milagre", folder))).length, 1);
  assert.ok(await fs.stat(path.join(project, ".milagre", "chats.db")));
  assert.ok(await fs.stat(`${stateFile(project)}.before-chats-db`));
  const restored = await readProjectState(project);
  assert.equal(restored.messages[0].body, "Saved reply");
  const { withDetails, hydrateSubagents } = require("./project-content.cjs");
  assert.equal((await withDetails(project, restored.messages[0])).steps[0].detail, detail);
  assert.deepEqual((await hydrateSubagents(project, restored)).sessions[1].subagents[0].transcript, transcript);
  assert.ok(await fs.stat(restored.messages[0].images[0].path));
  assert.equal(git("status", "--porcelain"), "");
  git("add", ".");
  assert.equal(git("diff", "--cached", "--name-only"), "");
});

test("an existing metadata ignore symlink is never followed or replaced", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-ignore-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, ".milagre"));
  const file = path.join(project, ".milagre", ".gitignore");
  await fs.symlink(path.join(project, "missing-ignore"), file);
  ensureProjectIgnore(project);
  assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
  await assert.rejects(fs.stat(path.join(project, "missing-ignore")), { code: "ENOENT" });
});

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ensureProjectIgnore } = require("./project-ignore.cjs");
const { readProjectState, saveProjectState, stateFile } = require("./project-store.cjs");

test("unsupported hard links leave existing ignore files and symlinks untouched, without partial rules", async (t) => {
  const syncFs = require("node:fs");
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-ignore-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const directory = path.join(project, ".milagre");
  const destination = path.join(directory, ".gitignore");
  await fs.mkdir(directory);
  const warn = t.mock.method(console, "warn", () => {});
  for (const code of ["ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
    const link = t.mock.method(syncFs, "linkSync", () => {
      throw Object.assign(new Error("hard links unsupported"), { code });
    });
    ensureProjectIgnore(project);
    assert.deepEqual(await fs.readdir(directory), []);
    await fs.writeFile(destination, "# User rules\n*.local\n");
    ensureProjectIgnore(project);
    assert.equal(await fs.readFile(destination, "utf8"), "# User rules\n*.local\n");
    assert.deepEqual(await fs.readdir(directory), [".gitignore"]);
    await fs.unlink(destination);
    await fs.symlink(path.join(project, "missing-ignore"), destination);
    ensureProjectIgnore(project);
    assert.equal((await fs.lstat(destination)).isSymbolicLink(), true);
    await assert.rejects(fs.stat(path.join(project, "missing-ignore")), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(directory), [".gitignore"]);
    await fs.unlink(destination);
    link.mock.restore();
  }
  assert.equal(warn.mock.callCount(), 9);
  assert.match(warn.mock.calls[0].arguments[0], /automatic runtime-state ignore protection was skipped/);
});

test("other publication failures remain errors and remove temporary rules", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-ignore-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const directory = path.join(project, ".milagre");
  await fs.mkdir(directory);
  for (const code of ["EACCES", "EPERM", "ENOSPC", "EIO"]) {
    const link = t.mock.method(require("node:fs"), "linkSync", () => {
      throw Object.assign(new Error("publication failed"), { code });
    });
    assert.throws(() => ensureProjectIgnore(project), { code });
    assert.deepEqual(await fs.readdir(directory), []);
    link.mock.restore();
  }
});

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

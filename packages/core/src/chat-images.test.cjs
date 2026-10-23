const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { ProjectStates } = require("./project-states.cjs");
const { ChatImages } = require("./chat-images.cjs");
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("image")]);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-image-test-"));
  const project = path.join(root, "repo");
  await fs.mkdir(project);
  const file = path.join(root, "left bar.png");
  await fs.writeFile(file, png);
  const state = {
    sessions: { 1: { worktree_id: 1 } },
    worktrees: { 1: { path: project } },
    messages: [{ id: 1, session_id: 1, role: "assistant", body: `![Drawer](<${file}>)` }],
  };
  const states = new ProjectStates({ read: async () => state, save: async () => {} });
  await states.get(project);
  const runs = {};
  const images = new ChatImages({ states, runs: () => runs, broadcast() {} });
  t.after(async () => {
    await states.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { project, file, state, states, images, runs };
}

test("a referenced temporary screenshot is copied into the Project and survives removal of its source", async (t) => {
  const { project, file, states, images } = await fixture(t);
  const stored = await images.resolve(project, file);
  assert.ok(stored.startsWith(path.join(await fs.realpath(project), ".milagre", "images")));
  assert.deepEqual(await fs.readFile(stored), png);
  assert.equal((await states.get(project)).messages[0].images[0].sourcePath, file);
  await fs.unlink(file);
  assert.equal(await images.resolve(project, file), stored);
});

test("only actual image references grant access, scoped to their Project", async (t) => {
  const { project, file, state, images } = await fixture(t);
  for (const body of [`[link](${file})`, `\`![image](<${file}>)\``, `\`\`\`\n![image](<${file}>)\n\`\`\``]) {
    state.messages[0].body = body;
    assert.equal(await images.resolve(project, file), null);
  }
  state.messages[0].body = `![image](<${file}>)`;
  state.messages[0].role = "user";
  assert.equal(await images.resolve(project, file), null);
  await assert.rejects(images.resolve("/not-open", file), /Open/);
});

test("file URIs and relative image paths resolve against the Chat Worktree", async (t) => {
  for (const kind of ["relative", "uri"]) {
    const { project, file, state, images } = await fixture(t);
    state.messages[0].body = kind === "relative" ? "![image](../left%20bar.png)" : `![image](file://${file.replaceAll(" ", "%20")})`;
    assert.ok(await images.resolve(project, file));
  }
});

test("live image references become durable attachments when their reply is saved", async (t) => {
  const { project, file, state, states, images, runs } = await fixture(t);
  const reply = state.messages.pop();
  runs[`${project}#1`] = { text: reply.body, steps: [] };
  const stored = await images.resolve(project, file);
  assert.ok(stored);
  state.messages.push(reply);
  delete runs[`${project}#1`];
  await fs.unlink(file);
  assert.equal(await images.resolve(project, file), stored);
  assert.equal((await states.get(project)).messages[0].images[0].path, stored);
});

test("non-images and oversized local files are not captured", async (t) => {
  const { project, file, images } = await fixture(t);
  await fs.writeFile(file, "private text with a png extension");
  await assert.rejects(images.resolve(project, file), /image/);
  await fs.writeFile(file, Buffer.alloc(51 * 1024 * 1024));
  await assert.rejects(images.resolve(project, file), /MiB/);
});

test("reusing a screenshot filename in a later reply captures the new bytes", async (t) => {
  const { project, file, state, images } = await fixture(t);
  const first = await images.capture(project, state, state.messages[0]);
  const newer = Buffer.concat([png, Buffer.from("new screenshot")]);
  await fs.writeFile(file, newer);
  const second = await images.capture(project, state, { ...state.messages[0], id: 2 });
  assert.notEqual(first.images[0].path, second.images[0].path);
  assert.deepEqual(await fs.readFile(first.images[0].path), png);
  assert.deepEqual(await fs.readFile(second.images[0].path), newer);
});

test("a similarly named Project cannot authorize another Project image", async (t) => {
  const { project, file, state, images, runs } = await fixture(t);
  const reply = state.messages.pop();
  runs[`${project}#other#1`] = { text: reply.body, steps: [] };
  assert.equal(await images.resolve(project, file), null);
});

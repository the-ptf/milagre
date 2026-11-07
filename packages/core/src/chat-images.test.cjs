const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
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
    // pathToFileURL: a Windows path's URL is file:///C:/..., not file://C:\...
    state.messages[0].body = kind === "relative" ? "![image](../left%20bar.png)" : `![image](${pathToFileURL(file).href})`;
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

async function imageFiles(project, prefix, count) {
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const file = path.join(project, `${prefix}-${i}.png`);
      await fs.writeFile(file, Buffer.concat([png, Buffer.from(`${prefix}-${i}`)]));
      return file;
    }),
  );
}

function imageSteps(files, imageOrigin, sourceFile) {
  return files.map((file, i) => ({
    id: `${imageOrigin || "generated"}-${i}`,
    kind: "image",
    status: "done",
    title: "Image",
    file,
    ...(imageOrigin ? { imageOrigin } : {}),
    ...(sourceFile ? { sourceFile } : {}),
  }));
}

test("viewed snapshots have a separate allowance from 16 legacy Markdown and image-step paths", async (t) => {
  for (const count of [1, 16, 20]) {
    await t.test(`${count} snapshot candidates`, async (t) => {
      const { project, state, images } = await fixture(t);
      const legacy = await imageFiles(project, "legacy", 17);
      const viewed = await imageFiles(project, "viewed", count);
      // Snapshot steps come first; Markdown still precedes all untagged steps in the legacy selection.
      const reply = {
        ...state.messages[0],
        body: legacy
          .slice(0, 8)
          .map((file) => `![image](${file})`)
          .join("\n"),
        steps: [...imageSteps(viewed, "viewed"), ...imageSteps(legacy.slice(8))],
      };
      const captured = await images.capture(project, state, reply);
      const expected = [...legacy.slice(0, 16), ...viewed.slice(0, 16)];
      assert.deepEqual(
        captured.images.map((image) => image.sourcePath),
        expected,
      );
      assert.equal(await images.capture(project, state, captured), captured);
      // A late Markdown reference keeps its original precedence over the last legacy step.
      const late = await images.capture(project, state, { ...reply, body: `${reply.body}\n![late](${legacy[16]})` });
      assert.deepEqual(
        late.images.map((image) => image.sourcePath),
        [...legacy.slice(0, 8), legacy[16], ...legacy.slice(8, 15), ...viewed.slice(0, 16)],
      );
    });
  }
});

test("cross-selection dedupe does not backfill legacy slots or remove existing attachments", async (t) => {
  const { project, file, state, images } = await fixture(t);
  const retained = (await images.capture(project, state, state.messages[0])).images;
  const legacy = await imageFiles(project, "legacy", 17);
  const viewed = await imageFiles(project, "viewed", 16);
  const reply = {
    ...state.messages[0],
    body: legacy.map((file) => `![image](${file})`).join("\n"),
    images: retained,
    steps: imageSteps([legacy[0], ...viewed], "viewed"),
  };
  state.messages[0] = await images.capture(project, state, reply);
  assert.deepEqual(
    state.messages[0].images.map((image) => image.sourcePath),
    [file, ...legacy.slice(0, 16), ...viewed.slice(0, 15)],
  );
  // The automatic allowance is not an on-demand resolution quota.
  assert.ok(await images.resolve(project, legacy[16]));
  assert.ok(await images.resolve(project, viewed[15]));
});

test("live snapshots authorize only their image file, never provenance or an ordinary Read", async (t) => {
  const { project, file, state, images, runs } = await fixture(t);
  state.messages = [];
  const [snapshot] = await imageFiles(project, "live-snapshot", 1);
  runs[`${project}#1`] = {
    text: "Read an image",
    steps: [{ id: "read", kind: "read", title: "Read source", status: "done", file }, ...imageSteps([snapshot], "viewed", file)],
  };
  assert.equal(await images.resolve(project, file), null);
  const stored = await images.resolve(project, snapshot);
  assert.deepEqual(await fs.readFile(stored), Buffer.concat([png, Buffer.from("live-snapshot-0")]));
});

test("snapshot copies survive fresh-store reopen without authorizing their provenance", async (t) => {
  const { project, file, state, images } = await fixture(t);
  const snapshots = await imageFiles(project, "snapshot", 2);
  const reply = { ...state.messages[0], body: "Read two images", steps: imageSteps(snapshots, "viewed", file) };
  const captured = await images.capture(project, state, reply);
  const serialized = JSON.stringify({ ...state, messages: [captured] });
  assert.doesNotMatch(serialized, /base64|data:image/);
  const saved = path.join(project, "saved-state.json");
  await fs.writeFile(saved, serialized);
  for (const snapshot of snapshots) await fs.unlink(snapshot);
  const reopened = new ProjectStates({ read: async () => JSON.parse(await fs.readFile(saved, "utf8")), save: async () => {} });
  t.after(() => reopened.close());
  await reopened.get(project);
  const fresh = new ChatImages({ states: reopened, runs: () => ({}), broadcast() {} });
  assert.equal(fresh.copies.size, 0);
  assert.equal(await fresh.resolve(project, file), null);
  for (const [i, snapshot] of snapshots.entries()) {
    const resolved = await fresh.resolve(project, snapshot);
    assert.equal(resolved, captured.images[i].path);
    assert.deepEqual(await fs.readFile(resolved), Buffer.concat([png, Buffer.from(`snapshot-${i}`)]));
  }
  assert.equal(fresh.copies.size, 0);
});

test("failed snapshot copies preserve Read rows, the reply and unrelated images", async (t) => {
  const { project, file, state, images } = await fixture(t);
  const [valid, invalid, oversized] = await imageFiles(project, "snapshot", 3);
  await fs.writeFile(invalid, "not an image");
  await fs.truncate(oversized, 51 * 1024 * 1024);
  const missing = path.join(project, "missing.png");
  const read = { id: "read", kind: "read", title: "Read original", status: "done", file };
  const reply = { ...state.messages[0], steps: [read, ...imageSteps([missing, invalid, oversized, valid], "viewed")] };
  const captured = await images.capture(project, state, reply);
  assert.equal(captured.body, reply.body);
  assert.equal(captured.steps, reply.steps);
  assert.deepEqual(
    captured.images.map((image) => image.sourcePath),
    [file, valid],
  );
  const onlyFailed = { ...reply, body: "Read failed images", steps: imageSteps([missing, invalid, oversized], "viewed") };
  assert.equal(await images.capture(project, state, onlyFailed), onlyFailed);
  assert.equal(await images.capture(project, state, { ...reply, role: "user" }).then((message) => message.images), undefined);
});

test("Claude-produced snapshots and five late Markdown images reopen durably after deleting all sources", async (t) => {
  const { mapClaudeMessage } = require("./agents/events.cjs");
  const { applyRunEvent } = require("@milagre/shared/agent-runs");
  const { replyActivity, replyImageFile } = require("@milagre/shared/reply-parts");
  const { project, file, state, images } = await fixture(t);
  const provider = {};
  const key = `${project}#1`;
  let runs = applyRunEvent({}, key, { type: "turn-started", turnId: "snapshots" });
  const snapshots = [];
  const expected = new Map();
  t.after(async () => {
    for (const snapshot of snapshots) await fs.rm(snapshot, { force: true });
  });
  for (let i = 0; i < 16; i++) {
    const bytes = Buffer.concat([png, Buffer.from(`${project}-${i}`)]);
    const start = {
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: `r${i}`, name: "Read", input: { file_path: file } }] },
    };
    const end = {
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: `r${i}`,
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } }],
          },
        ],
      },
    };
    for (const event of [...mapClaudeMessage(start, provider), ...mapClaudeMessage(end, provider)]) {
      if (event.step?.kind === "image") {
        snapshots.push(event.step.file);
        expected.set(event.step.file, bytes);
      }
      runs = applyRunEvent(runs, key, event);
    }
  }
  const late = await imageFiles(project, "late-markdown", 5);
  const body = `[Source](<${file}>)\n` + late.map((image) => `![Late](<${image}>)`).join("\n");
  const reply = { ...state.messages[0], body, steps: runs[key].steps };
  const captured = await images.capture(project, state, reply);
  assert.equal(captured.images.length, 21);
  assert.deepEqual(
    captured.images.slice(0, 5).map((image) => image.sourcePath),
    late,
  );
  const saved = path.join(project, "producer-state.json");
  const serialized = JSON.stringify({ ...state, messages: [captured] });
  assert.doesNotMatch(serialized, /base64|data:image/);
  await fs.writeFile(saved, serialized);
  for (const source of [file, ...late, ...snapshots]) await fs.unlink(source);
  const reopened = new ProjectStates({ read: async () => JSON.parse(await fs.readFile(saved, "utf8")), save: async () => {} });
  t.after(() => reopened.close());
  const restored = (await reopened.get(project)).messages[0];
  const fresh = new ChatImages({ states: reopened, runs: () => ({}), broadcast() {} });
  const replyParts = replyActivity(restored.body, restored.steps);
  assert.equal(replyParts.viewedImages.length, 16);
  assert.equal(replyParts.activity.length, 16);
  assert.equal(await fresh.resolve(project, file), null, "the answer's provenance link grants no media access");
  for (const step of replyParts.viewedImages) {
    const stored = replyImageFile(step, restored.images);
    assert.notEqual(stored, step.file);
    assert.equal(await fresh.resolve(project, step.file), stored);
    assert.deepEqual(await fs.readFile(stored), expected.get(step.file));
  }
  assert.equal(fresh.copies.size, 0, "fresh resolution uses durable mappings, never cached copy promises");
});

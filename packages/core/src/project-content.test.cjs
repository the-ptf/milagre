const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const png = (bytes) => {
  const buffer = Buffer.alloc(bytes, 1);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  return "data:image/png;base64," + buffer.toString("base64");
};
async function project(t) {
  const p = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-content-")));
  t.after(() => fs.rm(p, { recursive: true, force: true }));
  return p;
}
test("attached images become durable project paths, independent of names and source files", async (t) => {
  const { storeImages } = require("./project-content.cjs");
  const p = await project(t);
  const [image] = await storeImages(p, [{ id: "../../escape", name: "screen.png", dataUrl: png(100), path: "/original/screen.png" }]);
  assert.equal(image.dataUrl, undefined);
  assert.equal(image.sourcePath, "/original/screen.png");
  assert.equal(path.dirname(image.path), path.join(p, ".milagre", "images"));
  assert.equal((await fs.readFile(image.path)).length, 100);
  await assert.rejects(storeImages(p, [{ dataUrl: "data:text/html;base64,AAAA" }]));
});
test("an image uploaded from a chosen file keeps that file as its source, not the upload's temporary path", async (t) => {
  const { storeImages } = require("./project-content.cjs");
  const p = await project(t);
  const [image] = await storeImages(p, [
    { id: "a", name: "screen.png", dataUrl: png(100), path: "/data/uploads/screen.png", sourcePath: "/Users/me/screen.png" },
  ]);
  assert.equal(image.sourcePath, "/Users/me/screen.png");
  assert.equal(path.dirname(image.path), path.join(p, ".milagre", "images"));
});
test("a 4.9 MB legacy Project shrinks while images and complete child transcript survive restart", async (t) => {
  const { readProjectState, saveProjectState, stateFile } = require("./project-store.cjs");
  const p = await project(t);
  const original = {
    next_id: 3,
    projects: {},
    worktrees: {},
    sessions: {
      1: {
        id: 1,
        subagents: [
          {
            id: "child",
            title: "Review",
            transcript: Array.from({ length: 50 }, (_, i) => ({ id: String(i), kind: "message", text: "Result " + i + " " + "x".repeat(1000) })),
          },
        ],
      },
    },
    messages: [{ id: 2, session_id: 1, body: "Keep this", images: [{ id: "screenshot", name: "screen.png", dataUrl: png(3700000) }] }],
  };
  await fs.mkdir(path.dirname(stateFile(p)), { recursive: true });
  await fs.writeFile(stateFile(p), JSON.stringify(original, null, 2));
  assert.ok((await fs.stat(stateFile(p))).size > 4900000);
  const loaded = await readProjectState(p);
  assert.equal(loaded.messages[0].images[0].dataUrl, original.messages[0].images[0].dataUrl);
  await saveProjectState(p, loaded);
  const contents = await fs.readFile(stateFile(p), "utf8");
  assert.ok(contents.length < 10000, contents.length);
  const wire = JSON.parse(contents);
  assert.equal(wire.sessions[1].subagents[0].transcript.length, 1);
  const again = await readProjectState(p);
  assert.deepEqual(again.sessions[1].subagents[0].transcript, original.sessions[1].subagents[0].transcript);
  assert.equal((await fs.readFile(again.messages[0].images[0].path)).length, 3700000);
  assert.equal(again.messages[0].body, "Keep this");
  assert.equal(contents.includes("\n  "), false);
});
test("content storage refuses a symlink outside the Project without altering the target", async (t) => {
  const { storeImages } = require("./project-content.cjs");
  const p = await project(t);
  const other = await project(t);
  await fs.mkdir(path.join(p, ".milagre"));
  await fs.symlink(other, path.join(p, ".milagre", "images"));
  await assert.rejects(storeImages(p, [{ id: "x", name: "screen.png", dataUrl: png(100) }]), /outside/);
  assert.deepEqual(await fs.readdir(other), []);
});

test("a missing transcript sidecar keeps its reference across another save", async (t) => {
  const { saveProjectState, readProjectState, stateFile } = require("./project-store.cjs");
  const p = await project(t);
  const state = { sessions: { 1: { subagents: [{ id: "child", transcript: [{ id: "m", kind: "message", text: "x".repeat(2000) }] }] } }, messages: [] };
  await saveProjectState(p, state);
  const first = JSON.parse(await fs.readFile(stateFile(p), "utf8"));
  const file = first.sessions[1].subagents[0].transcriptFile;
  await fs.rename(path.join(p, ".milagre", "subagents", file), path.join(p, "temporarily-moved.json"));
  const loaded = await readProjectState(p);
  await saveProjectState(p, loaded);
  const saved = JSON.parse(await fs.readFile(stateFile(p), "utf8"));
  assert.ok([saved.sessions[1].subagents[0].transcriptFile, ...saved.sessions[1].subagents[0].transcriptFiles].includes(file));
  await fs.rename(path.join(p, "temporarily-moved.json"), path.join(p, ".milagre", "subagents", file));
  assert.equal((await readProjectState(p)).sessions[1].subagents[0].transcript[0].text.length, 2000);
});

test("a partial content write does not poison a retry after disk recovery", async (t) => {
  const { storeImages } = require("./project-content.cjs");
  const p = await project(t);
  const original = fs.writeFile;
  let fail = true;
  t.mock.method(fs, "writeFile", async (file, bytes, ...args) => {
    if (fail && String(file).includes("/images/")) {
      await original(file, Buffer.from(bytes).subarray(0, 10), ...args);
      fail = false;
      throw new Error("disk full");
    }
    return original(file, bytes, ...args);
  });
  const input = [{ id: "x", name: "s.png", dataUrl: png(100) }];
  await assert.rejects(storeImages(p, input), /disk full/);
  const [stored] = await storeImages(p, input);
  assert.equal((await fs.stat(stored.path)).size, 100);
  assert.equal((await fs.readdir(path.dirname(stored.path))).length, 1);
});

test("new child output preserves temporarily unavailable history through save and reload", async (t) => {
  const { saveProjectState, readProjectState, stateFile } = require("./project-store.cjs");
  const { applyAgentEvent } = require("@milagre/shared/agent-runs");
  const p = await project(t);
  const transcript = [
    { id: "first", kind: "message", text: "First result" },
    { id: "last", kind: "message", text: "x".repeat(2000) },
  ];
  await saveProjectState(p, {
    next_id: 2,
    sessions: { 1: { id: 1, subagents: [{ id: "child", title: "Review", startedAt: 1, updatedAt: 2, transcript }] } },
    messages: [],
  });
  const file = JSON.parse(await fs.readFile(stateFile(p), "utf8")).sessions[1].subagents[0].transcriptFile;
  await fs.rename(path.join(p, ".milagre", "subagents", file), path.join(p, "missing.json"));
  let loaded = await readProjectState(p);
  loaded = applyAgentEvent(loaded, {}, p, p + "#1", {
    type: "subagent-update",
    agent: { id: "child", title: "Review", startedAt: 1, updatedAt: 3, transcript: [{ id: "new", kind: "message", text: "New result" }] },
  }).state;
  await saveProjectState(p, loaded);
  await fs.rename(path.join(p, "missing.json"), path.join(p, ".milagre", "subagents", file));
  const restored = (await readProjectState(p)).sessions[1].subagents[0].transcript;
  assert.deepEqual(restored, [...transcript, { id: "new", kind: "message", text: "New result" }]);
});

test("reading legacy state never writes coordination.json outside its owner", async (t) => {
  const { readProjectState, saveProjectState, stateFile } = require("./project-store.cjs");
  const p = await project(t);
  const old = { sessions: { 1: { title: "Old" } }, messages: [{ id: 1, images: [{ id: "x", name: "s.png", dataUrl: png(100) }] }] };
  await fs.mkdir(path.dirname(stateFile(p)), { recursive: true });
  await fs.writeFile(stateFile(p), JSON.stringify(old));
  let writes = 0;
  const original = fs.rename;
  t.mock.method(fs, "rename", async (...args) => {
    if (args[1] === stateFile(p)) writes++;
    return original(...args);
  });
  await readProjectState(p);
  assert.equal(writes, 0, "reads must not publish a stale migrated snapshot");
  await saveProjectState(p, { ...old, sessions: { 1: { title: "Acknowledged" } } });
  assert.equal(JSON.parse(await fs.readFile(stateFile(p), "utf8")).sessions[1].title, "Acknowledged");
});

const longOutput = (label) => `$ ${label}\n`.padEnd(5000, "output line\n");
const reply = (id, steps) => ({ id, session_id: 1, role: "assistant", body: "Done", context: null, steps });
test("long tool output moves to one sidecar per message and reads back whole", async (t) => {
  const { compactDetails, withDetails, INLINE_DETAIL } = require("./project-content.cjs");
  const p = await project(t);
  const message = reply(1, [
    { id: "short", kind: "read", title: "Read a file", status: "done", detail: "x".repeat(INLINE_DETAIL) },
    { id: "long", kind: "shell", title: "Ran `npm test`", status: "done", detail: longOutput("npm test") },
    { id: "plain", kind: "edit", title: "Edited a file", status: "done" },
  ]);
  const state = { messages: [message] };
  const tracker = {};
  const compacted = await compactDetails(p, state, { tracker });
  assert.equal(tracker.wrote, true);
  const [saved] = compacted.messages;
  assert.match(saved.detailFile, /^[a-f0-9]{64}\.json$/);
  assert.equal(saved.steps[0].detail.length, INLINE_DETAIL, "short output stays inline");
  assert.equal(saved.steps[1].detail, undefined);
  assert.equal(saved.steps[1].hasDetail, true);
  assert.deepEqual(saved.steps[2], message.steps[2]);
  assert.ok((await fs.stat(path.join(p, ".milagre", "details", saved.detailFile))).isFile());
  assert.deepEqual(await withDetails(p, saved), message, "reading it back gives the message as it was");
  assert.equal(await compactDetails(p, compacted), compacted, "a compacted state is returned as is");
});

test("output the app reads without opening a step stays inline", async (t) => {
  const { compactDetails } = require("./project-content.cjs");
  const p = await project(t);
  const steps = [
    { id: "think-1", kind: "thinking", title: "Thought", status: "done", detail: "early ".repeat(500) },
    { id: "pr", kind: "shell", title: "Ran `gh pr create`", status: "done", detail: longOutput("gh pr create --fill") },
    { id: "think-2", kind: "thinking", title: "Thought", status: "done", detail: "last ".repeat(500) },
    { id: "live", kind: "shell", title: "Ran `sleep`", status: "running", detail: longOutput("sleep 100") },
  ];
  const [saved] = (await compactDetails(p, { messages: [reply(1, steps)] })).messages;
  assert.equal(saved.steps[0].hasDetail, true, "an earlier thought moves");
  assert.equal(saved.steps[1].detail, steps[1].detail, "a command that opened a PR stays for the chat's PR list");
  assert.equal(saved.steps[2].detail, steps[2].detail, "the last thought stays, shown when a reply has no answer");
  assert.equal(saved.steps[3].detail, steps[3].detail, "a running step is never moved");
});

test("an update looks only at the messages it added, and a missing sidecar leaves the step closed", async (t) => {
  const { compactDetails, withDetails } = require("./project-content.cjs");
  const p = await project(t);
  const first = (await compactDetails(p, { messages: [reply(1, [{ id: "a", kind: "shell", title: "Ran", status: "done", detail: longOutput("a") }])] }))
    .messages[0];
  // An unchanged old message with long output inline is left alone when the caller names it as already compacted.
  const legacy = reply(2, [{ id: "b", kind: "shell", title: "Ran", status: "done", detail: longOutput("b") }]);
  const added = reply(3, [{ id: "c", kind: "shell", title: "Ran", status: "done", detail: longOutput("c") }]);
  const next = await compactDetails(p, { messages: [first, legacy, added] }, { previous: [first, legacy] });
  assert.equal(next.messages[0], first);
  assert.equal(next.messages[1], legacy);
  assert.equal(next.messages[2].steps[0].hasDetail, true);
  await fs.rm(path.join(p, ".milagre", "details", first.detailFile));
  assert.equal(await withDetails(p, first), first);
});

test("a sidecar that does not match its name is not read", async (t) => {
  const { compactDetails, withDetails } = require("./project-content.cjs");
  const p = await project(t);
  const [saved] = (await compactDetails(p, { messages: [reply(1, [{ id: "a", kind: "shell", title: "Ran", status: "done", detail: longOutput("a") }])] }))
    .messages;
  await fs.writeFile(path.join(p, ".milagre", "details", saved.detailFile), JSON.stringify({ a: "tampered" }));
  assert.equal(await withDetails(p, saved), saved);
  const escaping = { ...saved, detailFile: "../coordination.json" };
  assert.equal(await withDetails(p, escaping), escaping);
});

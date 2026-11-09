const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { mapClaudeMessage } = require("./events.cjs");
const { saveToolImage } = require("./tool-image.cjs");
const { applyRunEvent } = require("@milagre/shared/agent-runs");
const { replyActivity } = require("@milagre/shared/reply-parts");

const png = () => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(randomUUID())]);
const image = (bytes) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } });
const call = (id, name = "Read", parent_tool_use_id = null) => ({
  type: "assistant",
  parent_tool_use_id,
  message: { content: [{ type: "tool_use", id, name, input: { file_path: "/missing/source.png" } }] },
});
const result = (id, content, extra = {}) => ({
  type: "user",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] },
});

test("shared byte writer validates, deduplicates, restricts permissions and rejects unsafe media", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-tool-images-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = png();
  const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  const file = saveToolImage(dataUrl, directory);
  assert.equal(saveToolImage(dataUrl, directory), file);
  assert.deepEqual(fs.readFileSync(file), bytes);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (const invalid of ["data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,bm90IHBuZw==", dataUrl + "!", "https://example.com/a.png"])
    assert.throws(() => saveToolImage(invalid, directory));
  assert.throws(() => saveToolImage(dataUrl, file), "a write failure stays with the block's caller");
});

test("Claude Read keeps completion and snapshots actual content blocks, including batched and mixed results", (t) => {
  const state = {};
  const bytes = [png(), png()];
  mapClaudeMessage(call("a"), state);
  mapClaudeMessage(call("b"), state);
  const first = result("a", [{ type: "text", text: "image" }, image(bytes[0]), image(Buffer.from("invalid")), image(bytes[1])]);
  const second = result("b", [{ type: "text", text: "ordinary Read" }]);
  const events = mapClaudeMessage({ ...first, message: { content: [...first.message.content, ...second.message.content] } }, state);
  const starts = events.filter((event) => event.step?.kind === "image").map((event) => event.step);
  t.after(() => starts.forEach((step) => fs.rmSync(step.file, { force: true })));
  assert.deepEqual(
    starts.map((step) => step.id),
    ["a:image:1", "a:image:3"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "step-completed").map((event) => event.id),
    ["a", "a:image:1", "a:image:3", "b"],
  );
  starts.forEach((step, index) => {
    assert.equal(step.imageOrigin, "viewed");
    assert.equal(step.sourceFile, "/missing/source.png");
    assert.notEqual(step.file, step.sourceFile);
    assert.deepEqual(fs.readFileSync(step.file), bytes[index]);
  });
  assert.doesNotMatch(JSON.stringify(events), /base64|media_type/);
  assert.deepEqual(mapClaudeMessage(first, state), [], "a consumed result cannot replay snapshots");
});

test("ordinary, failed, unmatched, subagent and MCP Read-like results never create previews", () => {
  const state = {};
  const bytes = png();
  const content = [image(bytes)];
  assert.deepEqual(mapClaudeMessage(result("unknown", content), state), []);
  for (const [id, name, parent, extra] of [
    ["bad", "Read", null, { is_error: true }],
    ["mcp", "mcp__files__Read", null, {}],
    ["child", "Read", "agent", {}],
  ]) {
    mapClaudeMessage(call(id, name, parent), state);
    const events = mapClaudeMessage({ ...result(id, content, extra), parent_tool_use_id: parent }, state);
    assert.equal(
      events.some((event) => event.step?.kind === "image"),
      false,
    );
  }
  mapClaudeMessage(call("text"), state);
  assert.equal(mapClaudeMessage(result("text", [{ type: "text", text: "plain file" }]), state).length, 1);
  mapClaudeMessage(call("structured-only"), state);
  assert.equal(mapClaudeMessage({ ...result("structured-only", "plain"), tool_use_result: { type: "image", ...image(bytes) } }, state).length, 1);
  mapClaudeMessage(call("url"), state);
  assert.equal(mapClaudeMessage(result("url", [{ type: "image", source: { type: "url", url: "file:///source.png" } }]), state).length, 1);
  mapClaudeMessage(call("replay"), state);
  assert.equal(mapClaudeMessage({ ...result("replay", content), isReplay: true }, state).length, 1);
});

test("20 actual Read results retain every Read row and admit 16 previews per reply", (t) => {
  const state = {};
  let runs = {};
  const files = new Set();
  t.after(() => files.forEach((file) => fs.rmSync(file, { force: true })));
  const key = "/project#1";
  const apply = (events) => {
    for (const event of events) {
      if (event.step?.kind === "image") files.add(event.step.file);
      runs = applyRunEvent(runs, key, event);
    }
  };
  apply([{ type: "turn-started", turnId: "t" }]);
  for (let i = 0; i < 20; i++) {
    apply(mapClaudeMessage(call(`read-${i}`), state));
    apply(mapClaudeMessage(result(`read-${i}`, [image(png())]), state));
  }
  const reply = replyActivity("Answer refers to /missing/source.png", runs[key].steps);
  assert.equal(reply.viewedImages.length, 16);
  assert.equal(reply.activity.length, 20);
  assert.equal(reply.images.length, 0);
  assert.ok(reply.activity.every((entry) => entry.step.kind === "read" && entry.step.status === "done"));
});

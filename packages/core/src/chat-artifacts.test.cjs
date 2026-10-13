const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { z } = require("zod");
const { createChatArtifacts, artifactToolDefinitions, htmlArtifactToolDefinitions, artifactCommentToolDefinitions } = require("./chat-artifacts.cjs");

const CHAT = "/repo#3";
// design_show and design_apply answer with the summary JSON on line 1, then notes and warnings.
const firstLine = (result) => JSON.parse(result.text.split("\n", 1)[0]);
const designDocument = () => ({
  schemaVersion: 1,
  width: 390,
  height: 844,
  background: "#f5f4ef",
  tokens: { ink: "#16261f" },
  nodes: [
    { id: "content", name: "Content", type: "frame", x: 24, y: 72, width: 342, height: 200, layout: "vertical", gap: 16 },
    { id: "heading", parentId: "content", name: "Heading", type: "text", width: 342, height: 48, text: "Welcome", fontSize: 30, fill: "$ink" },
  ],
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chat-artifacts-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const api = createChatArtifacts({
    directory,
    validateChat: async (chatId) => {
      if (chatId !== CHAT && chatId !== "/repo#4") throw Error("Open an existing Chat before showing a design.");
    },
  });
  const tools = Object.fromEntries(artifactToolDefinitions(CHAT, api).map((tool) => [tool.name, tool]));
  return { api, tools, directory };
}

test("Designs is on by default, persists off, and gates already cached tools and all operations", async (t) => {
  const { api, tools, directory } = await fixture(t);
  assert.equal(api.enabled(), true);
  assert.equal(typeof api.show, "function");
  assert.equal(tools.artifact_show, undefined);
  assert.equal(tools.artifact_read, undefined);
  await tools.design_show.run({ id: "welcome", title: "Welcome", document: designDocument() });
  const [comment] = await api.addComments({ chatId: CHAT, comments: [{ design: { id: "welcome", version: 1 }, text: "Bigger" }] });
  assert.deepEqual(await api.setEnabled(false), { enabled: false });
  assert.deepEqual(artifactToolDefinitions(CHAT, api), []);
  const request = { chatId: CHAT, id: "welcome" };
  const calls = [
    () => tools.design_show.run({ id: "new", title: "New", document: designDocument() }),
    () => tools.design_read.run({ id: "welcome" }),
    () => tools.design_apply.run({ id: "welcome", expectedVersion: 1, operations: [{ op: "delete", id: "heading" }] }),
    () => tools.design_export.run({ id: "welcome", format: "json" }),
    () => api.list({ ...request, format: "design" }),
    () => api.addComments({ ...request, comments: [{ design: { id: "welcome", version: 1 }, text: "Hidden" }] }),

    () => tools.artifact_resolve_comment.run({ id: comment.id, note: "Done" }),
  ];
  for (const call of calls) await assert.rejects(call(), /Designs are off/);
  assert.deepEqual(await api.list(request), []);
  assert.deepEqual(await api.comments(request), []);
  const restarted = createChatArtifacts({ directory, validateChat: async () => {} });
  assert.equal(restarted.enabled(), false);
  await restarted.setEnabled(true);
  assert.equal((await restarted.get(request)).version, 1);
  assert.equal((await restarted.comments(request)).length, 1);
  assert.equal((await restarted.comments(request))[0].resolved, undefined);
  await restarted.setEnabled(false);
  await restarted.removeChat(CHAT);
  await restarted.setEnabled(true);
  assert.deepEqual(await restarted.list(request), []);
});

test("turning Designs off is ordered with accepted writes and rejects queued later writes", async (t) => {
  const { api } = await fixture(t);
  const first = api.showDesign({ chatId: CHAT, id: "welcome", title: "Welcome", document: designDocument() });
  const off = api.setEnabled(false);
  const later = api.apply({ chatId: CHAT, id: "welcome", expectedVersion: 1, operations: [{ op: "delete", id: "heading" }] });
  assert.equal((await first).version, 1);
  assert.deepEqual(await off, { enabled: false });
  await assert.rejects(later, /Designs are off/);
  await api.setEnabled(true);
  assert.equal((await api.get({ chatId: CHAT, id: "welcome" })).version, 1);
  await assert.rejects(api.setEnabled("false"), /boolean/);
  assert.equal(api.enabled(), true);
});

test("legacy HTML reopens as one current artifact and keeps old files and comments", async (t) => {
  const { api, directory } = await fixture(t);
  await api.showDesign({ chatId: CHAT, id: "active", title: "Active", document: designDocument() });
  const folder = await chatFolder(directory);
  await fs.writeFile(path.join(folder, "old.json"), JSON.stringify({ id: "old", versions: [{ version: 1, title: "Old", html: "<p>Old</p>", createdAt: 1 }] }));
  const split = path.join(folder, "split");
  await fs.mkdir(split);
  await fs.writeFile(path.join(split, "meta.json"), JSON.stringify({ id: "split", versions: [{ version: 1, title: "Newer", createdAt: 2 }] }));
  await fs.writeFile(path.join(split, "v1.html"), "<p>Newer</p>");
  assert.deepEqual(
    (await api.list({ chatId: CHAT, format: "html" })).map((item) => item.id),
    ["split"],
  );
  assert.equal((await api.get({ chatId: CHAT, id: "old", version: 1 })).html, "<p>Newer</p>");
  assert.equal((await api.get({ chatId: CHAT, id: "old" })).format, "html");
  assert.equal(await fs.readFile(path.join(folder, "old", "v1.html"), "utf8"), "<p>Old</p>");
  for (const id of ["old", "split"]) {
    await assert.rejects(api.showDesign({ chatId: CHAT, id, title: "Overwrite", document: designDocument() }), /separate formats/);
    await assert.rejects(api.exportDesign({ chatId: CHAT, id, format: "json" }), /separate formats/);
  }
  await fs.writeFile(
    path.join(folder, "comments"),
    JSON.stringify([
      { id: "00000001", design: { id: "old", version: 1 }, text: "Keep old feedback", createdAt: 1 },
      { id: "00000002", design: { id: "split", version: 1 }, text: "Keep split feedback", createdAt: 2 },
      { id: "00000003", design: { id: "active", version: 1 }, text: "Design feedback", createdAt: 3 },
    ]),
  );
  assert.equal((await api.comments({ chatId: CHAT })).length, 3);
  await api.resolveComment({ chatId: CHAT, id: "00000001", note: "Updated the live artifact" });
  await api.setEnabled(false);
  assert.deepEqual(
    (await api.comments({ chatId: CHAT })).map((comment) => comment.id),
    ["00000001", "00000002"],
  );
  assert.equal((await api.list({ chatId: CHAT }))[0].id, "split");
  assert.equal((await api.get({ chatId: CHAT, id: "old", version: 1 })).html, "<p>Newer</p>");
  await api.show({ chatId: CHAT, title: "Current explanation", html: "<p>Current</p>" });
  assert.equal((await api.get({ chatId: CHAT, id: "old", version: 1 })).html, "<p>Current</p>");
  assert.equal(await fs.readFile(path.join(split, "v1.html"), "utf8"), "<p>Newer</p>", "legacy HTML remains recoverable on disk");
});

test("HTML tool updates one live page independently of Designs, without version history", async (t) => {
  const { api, directory } = await fixture(t);
  const tools = Object.fromEntries([...htmlArtifactToolDefinitions(CHAT, api), ...artifactCommentToolDefinitions(CHAT, api)].map((tool) => [tool.name, tool]));
  await api.setEnabled(false);
  const first = JSON.parse(await tools.artifact_show.run({ title: "Explainer", html: "<p>One</p>" }));
  const updated = JSON.parse(await tools.artifact_show.run({ id: "different-id", title: "Updated", html: "<p>Two</p>" }));
  assert.equal(updated.id, first.id);
  assert.equal(updated.version, first.version + 1);
  assert.equal(updated.versions, 1);
  const folder = path.join(directory, require("node:crypto").createHash("sha256").update(CHAT).digest("hex").slice(0, 32), first.id);
  assert.deepEqual((await fs.readdir(folder)).sort(), ["meta.json", "v2.html"], "live updates retain only the current page");
  const read = JSON.parse(await tools.artifact_read.run({ id: first.id, version: first.version }));
  assert.equal(read.html, "<p>Two</p>");
  assert.equal(read.document, undefined);
  assert.equal(JSON.parse(await tools.artifact_list.run({})).length, 1);
  const snapshot = await api.pageSnapshot({ chatId: CHAT, title: "Shared explainer", kind: "artifacts" });
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    kind: "artifacts",
    title: "Shared explainer",
    artifacts: [{ title: "Updated", html: "<p>Two</p>", width: 1280, height: 800 }],
  });
  const [comment] = await api.addComments({ chatId: CHAT, comments: [{ design: { id: first.id, version: updated.version }, text: "Explain this" }] });
  await tools.artifact_show.run({ title: "Updated again", html: "<p>Three</p>" });
  await tools.artifact_resolve_comment.run({ id: comment.id, note: "Expanded explanation" });
  assert.equal(JSON.parse(await tools.artifact_comments.run({ all: true }))[0].resolved.note, "Expanded explanation");
  await assert.rejects(api.pageSnapshot({ chatId: CHAT, title: "Designs" }), /Designs are off/);
  await api.setEnabled(true);
  await api.showDesign({ chatId: CHAT, id: "screen", title: "Screen", document: designDocument() });
  await assert.rejects(tools.artifact_show.run({ id: "screen", title: "Overwrite", html: "<p>x</p>" }), /separate formats/);
  await assert.rejects(tools.artifact_read.run({ id: "screen" }), /separate formats/);
  await assert.rejects(api.get({ chatId: CHAT, id: first.id, format: "design" }), /separate formats/);
  await assert.rejects(tools.artifact_show.run({ title: "Oversized", html: "a".repeat(1_000_001) }), /limited/);
});

test("HTML feedback survives edits made while the comment is being composed", async (t) => {
  const { api } = await fixture(t);
  const first = await api.show({ chatId: CHAT, title: "Explainer", html: "<p>One</p>" });
  await api.show({ chatId: CHAT, title: "Explainer", html: "<p>Two</p>" });
  await api.setEnabled(false);
  const [comment] = await api.addComments({
    chatId: CHAT,
    comments: [{ id: "12345678", design: first, text: "Explain this paragraph" }],
  });
  assert.equal(comment.design.version, first.version);
  assert.equal((await api.comments({ chatId: CHAT }))[0].id, comment.id);
  await api.resolveComment({ chatId: CHAT, id: comment.id, note: "Expanded the paragraph" });
  assert.equal((await api.comments({ chatId: CHAT }))[0].resolved.note, "Expanded the paragraph");
  await assert.rejects(api.addComments({ chatId: CHAT, comments: [{ design: { ...first, version: 3 }, text: "Future revision" }] }), /not available/);
});

test("design documents and comment batches retain input and size validation", async (t) => {
  const { api } = await fixture(t);
  await assert.rejects(api.showDesign({ chatId: CHAT, title: "", document: designDocument() }), /title/);
  await assert.rejects(api.showDesign({ chatId: CHAT, title: "Bad", document: { ...designDocument(), width: -1 } }));
  await assert.rejects(
    api.showDesign({ chatId: CHAT, title: "Bad", document: { ...designDocument(), nodes: [designDocument().nodes[0], designDocument().nodes[0]] } }),
  );
  await assert.rejects(api.addComments({ chatId: CHAT, comments: [] }), /between 1 and 50/);
  await assert.rejects(api.addComments({ chatId: CHAT, comments: Array.from({ length: 51 }, () => ({})) }), /between 1 and 50/);
  await assert.rejects(api.addComments({ chatId: CHAT, comments: [{ design: { id: "missing", version: 1 }, text: "No source" }] }), /no longer available/);
  assert.deepEqual(await api.list({ chatId: CHAT }), []);
});

test("ids can't leave the Chat's folder", async (t) => {
  const { api } = await fixture(t);
  await assert.rejects(api.get({ chatId: CHAT, id: "../secrets" }), /lowercase letters/);
  await assert.rejects(api.showDesign({ chatId: CHAT, id: "../x", title: "x", document: designDocument() }), /lowercase letters/);
});

test("the agent resolves the user's comments with a note, and lists the open ones", async (t) => {
  const { api, tools } = await fixture(t);
  await tools.design_show.run({ id: "home", title: "Home", document: designDocument() });
  const design = { id: "home", version: 1, title: "Home" };
  const added = await api.addComments({
    chatId: CHAT,
    comments: [
      { design, x: 0.5, y: 0.2, text: " Bigger title " },
      { design, text: "Too busy" },
    ],
  });
  assert.equal(added.length, 2);
  assert.match(added[0].id, /^[a-f0-9]{8}$/);
  assert.deepEqual([added[0].text, added[0].x, added[1].x], ["Bigger title", 0.5, undefined]);
  const resolved = JSON.parse(await tools.artifact_resolve_comment.run({ id: added[0].id, note: "Title is 32px now" }));
  assert.equal(resolved.resolved.note, "Title is 32px now");
  assert.deepEqual(
    JSON.parse(await tools.artifact_comments.run({})).map((comment) => comment.text),
    ["Too busy"],
  );
  assert.equal(JSON.parse(await tools.artifact_comments.run({ all: true })).length, 2);
  await assert.rejects(tools.artifact_resolve_comment.run({ id: "ffffffff", note: "x" }), /No comment ffffffff/);
  // The comments file is no design.
  assert.deepEqual(
    (await api.list({ chatId: CHAT })).map((item) => item.id),
    ["home"],
  );
  await assert.rejects(api.comments({ chatId: "/other#1" }), /existing Chat/);
});

test("comments the app names are kept by that id, once", async (t) => {
  const { api } = await fixture(t);
  const design = { id: "home", version: 1, title: "Home" };
  await api.showDesign({ chatId: CHAT, id: "home", title: "Home", document: designDocument() });
  const comment = { design, text: "Bigger", id: "0a1b2c3d" };
  assert.equal((await api.addComments({ chatId: CHAT, comments: [comment] }))[0].id, "0a1b2c3d");
  await api.addComments({ chatId: CHAT, comments: [comment] });
  assert.deepEqual(
    (await api.comments({ chatId: CHAT })).map((item) => item.id),
    ["0a1b2c3d"],
    "a retried send records nothing twice",
  );
});

test("a layer-linked comment keeps its node id through persistence and resolution", async (t) => {
  const { api, tools, directory } = await fixture(t);
  const design = { id: "welcome", version: 1, title: "Welcome" };
  await api.showDesign({ chatId: CHAT, id: "welcome", title: "Welcome", document: designDocument() });
  await api.addComments({ chatId: CHAT, comments: [{ id: "0a1b2c3d", design, nodeId: "Card.title_2", x: 0.5, y: 0.2, text: "Make this heading larger" }] });
  const restarted = createChatArtifacts({ directory, validateChat: async () => {} });
  const saved = await restarted.comments({ chatId: CHAT });
  assert.equal(saved[0].nodeId, "Card.title_2");
  const comments = JSON.parse(await tools.artifact_comments.run({}));
  assert.equal(comments[0].nodeId, "Card.title_2");
  await tools.artifact_resolve_comment.run({ id: "0a1b2c3d", note: "Increased the heading size" });
  const resolved = JSON.parse(await tools.artifact_comments.run({ all: true }));
  assert.equal(resolved[0].nodeId, "Card.title_2");
  assert.equal(resolved[0].resolved.note, "Increased the heading size");
});

test("an invalid layer id rejects the whole comment batch", async (t) => {
  const { api } = await fixture(t);
  const design = { id: "welcome", version: 1, title: "Welcome" };
  await api.showDesign({ chatId: CHAT, id: "welcome", title: "Welcome", document: designDocument() });
  for (const nodeId of ["", "../heading", "bad id", "<script>", "1heading", "a".repeat(97), null, 12]) {
    await assert.rejects(
      api.addComments({
        chatId: CHAT,
        comments: [
          { design, nodeId: "heading", text: "Valid first" },
          { design, nodeId, text: "Invalid second" },
        ],
      }),
      /layer id/,
    );
  }
  assert.deepEqual(await api.comments({ chatId: CHAT }), []);
});

const chatFolder = async (directory) => path.join(directory, (await fs.readdir(directory))[0]);

test("removing a Chat deletes its designs and comments, and only its own", async (t) => {
  const { api, directory } = await fixture(t);
  await api.showDesign({ chatId: CHAT, id: "a", title: "Mine", document: designDocument() });
  await api.showDesign({ chatId: "/repo#4", title: "Other", document: designDocument() });
  await api.addComments({ chatId: CHAT, comments: [{ design: { id: "a", version: 1 }, text: "hi" }] });
  await api.removeChat(CHAT);
  assert.equal((await fs.readdir(directory)).length, 1);
  assert.deepEqual(await api.list({ chatId: CHAT }), []);
  assert.equal((await api.list({ chatId: "/repo#4" })).length, 1);
  await api.removeChat(CHAT);
});

test("editable designs persist their source and a preview, and survive a restarted store", async (t) => {
  const { api, tools, directory } = await fixture(t);
  const shown = firstLine(await tools.design_show.run({ id: "welcome", title: "Welcome screen", document: designDocument() }));
  assert.deepEqual(shown, { id: "welcome", title: "Welcome screen", version: 1, versions: 1, width: 390, height: 844, format: "design", warnings: [] });
  const design = await api.get({ chatId: CHAT, id: shown.id });
  assert.equal(design.document.nodes[1].text, "Welcome");
  assert.match(design.html, /Welcome/);
  assert.equal(design.latest, 1);
  const folder = path.join(await chatFolder(directory), shown.id);
  assert.deepEqual((await fs.readdir(folder)).sort(), ["meta.json", "v1.design.json", "v1.html"]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder, "v1.design.json"), "utf8")), design.document);
  const metadata = JSON.parse(await fs.readFile(path.join(folder, "meta.json"), "utf8"));
  assert.equal(metadata.versions[0].document, undefined);
  assert.equal(metadata.versions[0].html, undefined);

  const restarted = createChatArtifacts({ directory, validateChat: async () => {} });
  assert.deepEqual(await restarted.get({ chatId: CHAT, id: shown.id }), design);
  const read = JSON.parse(await tools.design_read.run({ id: shown.id }));
  assert.deepEqual(read.document, design.document);
  assert.equal(read.html, undefined, "reading editable layers does not spend output on a duplicate preview");
  await assert.rejects(api.get({ chatId: "/repo#4", id: shown.id }), /no longer available/);
});

test("editable design tool schemas expose layer fields and version checks to MCP agents", async (t) => {
  const { tools } = await fixture(t);
  const schemas = Object.fromEntries(
    ["design_show", "design_read", "design_apply", "design_export"].map((name) => [name, z.toJSONSchema(z.object(tools[name].input))]),
  );
  assert.equal(schemas.design_show.properties.document.properties.nodes.type, "array");
  assert.ok(schemas.design_apply.required.includes("expectedVersion"));
  assert.equal(schemas.design_apply.properties.operations.items.oneOf.length, 4);
  assert.deepEqual(schemas.design_export.properties.format.enum, ["json", "svg"]);
  assert.equal(tools.design_show.readOnly, false);
  assert.equal(tools.design_apply.readOnly, false);
  assert.equal(tools.design_read.readOnly, true);
  assert.equal(tools.design_export.readOnly, true);
});

test("a batch creates one immutable version with an updated source and preview", async (t) => {
  const { api, tools } = await fixture(t);
  await tools.design_show.run({ id: "welcome", title: "Welcome", document: designDocument() });
  const before = await api.get({ chatId: CHAT, id: "welcome" });
  const updated = await api.apply({
    chatId: CHAT,
    id: "welcome",
    expectedVersion: 1,
    operations: [
      { op: "update", id: "heading", patch: { text: "Your next project", fontSize: 34 } },
      { op: "insert", node: { id: "button", parentId: "content", type: "rectangle", width: 342, height: 48, fill: "#27634b" } },
    ],
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.latest, 2);
  assert.equal(updated.document.nodes[1].text, "Your next project");
  assert.equal(updated.document.nodes.length, 3);
  assert.match(updated.html, /Your next project/);
  assert.deepEqual(await api.get({ chatId: CHAT, id: "welcome", version: 1 }), { ...before, latest: 2, versions: 2 });

  const edited = firstLine(await tools.design_apply.run({ id: "welcome", expectedVersion: 2, operations: [{ op: "delete", id: "button" }] }));
  assert.equal(edited.version, 3);
  assert.equal(edited.title, "Welcome");
  assert.equal(edited.html, undefined);
  assert.equal(edited.document, undefined, "small edits return a version summary");
  assert.equal((await api.get({ chatId: CHAT, id: "welcome" })).document.nodes.length, 2);
});

test("concurrent edits cannot overwrite a user's newer design", async (t) => {
  const { api } = await fixture(t);
  await api.showDesign({ chatId: CHAT, id: "welcome", title: "Welcome", document: designDocument() });
  const edits = await Promise.allSettled(
    ["User's title", "Agent's stale title"].map((text) =>
      api.apply({ chatId: CHAT, id: "welcome", expectedVersion: 1, operations: [{ op: "update", id: "heading", patch: { text } }] }),
    ),
  );
  assert.equal(edits[0].status, "fulfilled");
  assert.equal(edits[1].status, "rejected");
  assert.equal(edits[1].reason.code, "DESIGN_VERSION_CONFLICT");
  assert.match(edits[1].reason.message, /expected version 1.*latest is 2/);
  const latest = await api.get({ chatId: CHAT, id: "welcome" });
  assert.equal(latest.version, 2);
  assert.equal(latest.document.nodes[1].text, "User's title");
  await assert.rejects(api.showDesign({ chatId: CHAT, id: "welcome", title: "Replacement", document: designDocument() }), /expectedVersion 2/);
  await assert.rejects(
    api.showDesign({ chatId: CHAT, id: "welcome", expectedVersion: 1, title: "Replacement", document: designDocument() }),
    /version conflict/,
  );
  await assert.rejects(api.apply({ chatId: CHAT, id: "welcome", operations: [{ op: "delete", id: "heading" }] }), /expectedVersion 2/);
});

test("a failed operation rolls back the whole batch without creating a version", async (t) => {
  const { api, directory } = await fixture(t);
  await api.showDesign({ chatId: CHAT, id: "welcome", title: "Welcome", document: designDocument() });
  const before = await api.get({ chatId: CHAT, id: "welcome" });
  await assert.rejects(
    api.apply({
      chatId: CHAT,
      id: "welcome",
      expectedVersion: 1,
      operations: [
        { op: "update", id: "heading", patch: { text: "Must not be saved" } },
        { op: "update", id: "missing", patch: { text: "Invalid layer" } },
      ],
    }),
  );
  assert.deepEqual(await api.get({ chatId: CHAT, id: "welcome" }), before);
  assert.deepEqual((await fs.readdir(path.join(await chatFolder(directory), "welcome"))).sort(), ["meta.json", "v1.design.json", "v1.html"]);
});

test("a failed metadata write removes the uncommitted document and preview", async (t) => {
  const { api, directory } = await fixture(t);
  await api.showDesign({ chatId: CHAT, id: "welcome", title: "Welcome", document: designDocument() });
  const before = await api.get({ chatId: CHAT, id: "welcome" });
  const rename = fs.rename;
  const mock = t.mock.method(fs, "rename", async (from, to) => {
    if (path.basename(to) === "meta.json") throw Object.assign(Error("Disk full"), { code: "ENOSPC" });
    return rename(from, to);
  });
  const request = { chatId: CHAT, id: "welcome", expectedVersion: 1, operations: [{ op: "update", id: "heading", patch: { text: "Saved later" } }] };
  try {
    await assert.rejects(api.apply(request), /Disk full/);
  } finally {
    mock.mock.restore();
  }
  assert.deepEqual(await api.get({ chatId: CHAT, id: "welcome" }), before);
  assert.deepEqual((await fs.readdir(path.join(await chatFolder(directory), "welcome"))).sort(), ["meta.json", "v1.design.json", "v1.html"]);
  assert.equal((await api.apply(request)).version, 2, "a failed write does not reserve a version or stall later edits");
});

test("design replacement requires the observed version, including a new id", async (t) => {
  const { api } = await fixture(t);
  const request = { chatId: CHAT, id: "welcome", expectedVersion: 0, title: "Welcome", document: designDocument() };
  await api.showDesign(request);
  await assert.rejects(api.showDesign(request), /expected version 0.*latest is 1/);
  const replacement = designDocument();
  replacement.width = 440;
  replacement.nodes[1].text = "Replaced";
  const result = await api.showDesign({ ...request, expectedVersion: 1, document: replacement });
  assert.equal(result.version, 2);
  assert.equal(result.width, 440);
  assert.equal((await api.get({ chatId: CHAT, id: "welcome" })).document.nodes[1].text, "Replaced");
});

test("JSON and SVG exports use the requested immutable design version", async (t) => {
  const { api, tools } = await fixture(t);
  await tools.design_show.run({ id: "welcome", title: "Welcome", document: designDocument() });
  await tools.design_apply.run({ id: "welcome", expectedVersion: 1, operations: [{ op: "update", id: "heading", patch: { text: "New title" } }] });
  const json = JSON.parse(await tools.design_export.run({ id: "welcome", version: 1, format: "json" }));
  assert.equal(json.filename, "welcome-v1.json");
  assert.equal(json.mimeType, "application/json");
  assert.equal(JSON.parse(json.content).nodes[1].text, "Welcome");
  const svg = JSON.parse(await tools.design_export.run({ id: "welcome", format: "svg" }));
  assert.equal(svg.filename, "welcome-v2.svg");
  assert.equal(svg.mimeType, "image/svg+xml");
  assert.match(svg.content, /<svg/);
  assert.match(svg.content, /New title/);
  await assert.rejects(api.exportDesign({ chatId: CHAT, id: "welcome", format: "html" }), /Choose json or svg/);
});

test("retention removes source and preview together and keeps version numbers increasing", async (t) => {
  const { api, tools, directory } = await fixture(t);
  await api.showDesign({ chatId: CHAT, id: "welcome", title: "Welcome", document: designDocument() });
  const [comment] = await api.addComments({
    chatId: CHAT,
    comments: [{ design: { id: "welcome", version: 1 }, nodeId: "heading", text: "Keep this feedback" }],
  });
  for (let version = 1; version < 52; version++)
    await api.apply({
      chatId: CHAT,
      id: "welcome",
      expectedVersion: version,
      operations: [{ op: "update", id: "heading", patch: { text: `Version ${version + 1}` } }],
    });
  const files = await fs.readdir(path.join(await chatFolder(directory), "welcome"));
  assert.equal(files.length, 101);
  assert.ok(!files.includes("v1.html") && !files.includes("v1.design.json") && !files.includes("v2.design.json"));
  assert.ok(files.includes("v3.html") && files.includes("v3.design.json") && files.includes("v52.design.json"));
  const latest = await api.get({ chatId: CHAT, id: "welcome" });
  assert.equal(latest.version, 52);
  assert.equal(latest.versions, 50);
  await assert.rejects(api.get({ chatId: CHAT, id: "welcome", version: 2 }), /no longer kept/);
  const comments = JSON.parse(await tools.artifact_comments.run({}));
  assert.equal(comments.length, 1);
  assert.equal(comments[0].design.version, 1, "the original feedback is never relabeled as the latest version");
  assert.equal(comments[0].nodeId, "heading");
  const resolved = JSON.parse(await tools.artifact_resolve_comment.run({ id: comment.id, note: "Addressed in the current design" }));
  assert.equal(resolved.design.version, 1);
  assert.equal(resolved.resolved.note, "Addressed in the current design");
  assert.deepEqual(JSON.parse(await tools.artifact_comments.run({})), []);
  assert.equal(JSON.parse(await tools.artifact_comments.run({ all: true }))[0].design.version, 1);
  await assert.rejects(
    api.addComments({ chatId: CHAT, comments: [{ design: { id: "welcome", version: 1 }, text: "Cannot add a new pin to a removed preview" }] }),
    /no longer kept/,
  );
  await assert.rejects(api.addComments({ chatId: CHAT, comments: [{ design: { id: "welcome", version: 53 }, text: "Future version" }] }), /not available/);
});

test("oversized rendered text never commits a new design or advances an existing version", async (t) => {
  const { api, directory } = await fixture(t);
  const request = { chatId: CHAT, id: "welcome" };
  await api.showDesign({ ...request, title: "Welcome", document: designDocument() });
  const before = await api.get(request);
  const document = {
    schemaVersion: 1,
    width: 390,
    height: 844,
    nodes: Array.from({ length: 40 }, (_, index) => ({
      id: `article${index}`,
      name: "Article body",
      type: "text",
      width: 1,
      height: 16000,
      fontSize: 2,
      lineHeight: 1,
      text: "a".repeat(20000),
    })),
  };
  await assert.rejects(api.showDesign({ ...request, id: "oversized", title: "Too much", document }), /8 MiB.*Article body/);
  await assert.rejects(api.apply({ ...request, expectedVersion: 1, operations: [{ op: "replace", document }] }), /8 MiB.*Article body/);
  assert.deepEqual(await api.get(request), before);
  assert.deepEqual(
    (await api.list({ chatId: CHAT })).map((item) => item.id),
    ["welcome"],
  );
  const folder = await chatFolder(directory);
  assert.deepEqual(await fs.readdir(folder), ["welcome"]);
  assert.deepEqual((await fs.readdir(path.join(folder, "welcome"))).sort(), ["meta.json", "v1.design.json", "v1.html"]);
});

test("design_show and design_apply attach the rendered design and its warnings", async (t) => {
  const { tools } = await fixture(t);
  const shown = await tools.design_show.run({ id: "welcome", title: "Welcome", document: designDocument() });
  assert.equal(firstLine(shown).version, 1);
  assert.deepEqual(firstLine(shown).warnings, []);
  assert.equal(shown.images.length, 1);
  assert.equal(shown.images[0].mime, "image/png");
  assert.match(shown.text, /\nLook at the image/);
  const edited = await tools.design_apply.run({
    id: "welcome",
    expectedVersion: 1,
    operations: [
      {
        op: "update",
        id: "heading",
        patch: { text: "A welcome heading long enough to wrap onto several lines inside a short box", heightMode: "fixed", height: 20 },
      },
    ],
  });
  assert.deepEqual(
    firstLine(edited).warnings.map((warning) => warning.kind),
    ["clipped-text"],
  );
  assert.match(edited.text, /- Text "heading" needs/);
});

test("a render failure still saves the version and returns the summary", async (t) => {
  const { api } = await fixture(t);
  const tools = Object.fromEntries(
    artifactToolDefinitions(CHAT, api, undefined, {
      renderPng: async () => {
        throw new Error("wasm missing");
      },
    }).map((tool) => [tool.name, tool]),
  );
  const shown = await tools.design_show.run({ id: "welcome", title: "Welcome", document: designDocument() });
  assert.equal(firstLine(shown).version, 1);
  assert.deepEqual(shown.images, []);
  assert.match(shown.text, /preview could not be rendered: wasm missing/);
  assert.equal((await api.get({ chatId: CHAT, id: "welcome" })).version, 1);
});

test("a design_show that fails validation or conflicts still throws before anything is drawn", async (t) => {
  const { tools } = await fixture(t);
  await tools.design_show.run({ id: "welcome", title: "Welcome", document: designDocument() });
  await assert.rejects(tools.design_show.run({ id: "welcome", title: "Again", document: designDocument(), expectedVersion: 5 }), /version|changed|conflict/i);
  await assert.rejects(
    tools.design_apply.run({ id: "welcome", expectedVersion: 9, operations: [{ op: "delete", id: "heading" }] }),
    /version|changed|conflict/i,
  );
});

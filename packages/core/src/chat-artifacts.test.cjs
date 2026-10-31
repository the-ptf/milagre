const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { z } = require("zod");
const { createExampleDesign } = require("@milagre/shared/design");
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

test("Designs are always on: tools exist, designs and comments survive a restarted store and Chat removal", async (t) => {
  const { api, tools, directory } = await fixture(t);
  assert.equal(api.enabled, undefined);
  assert.equal(api.setEnabled, undefined);
  assert.equal(typeof api.show, "function");
  assert.equal(tools.artifact_show, undefined);
  assert.equal(tools.artifact_read, undefined);
  assert.ok(artifactToolDefinitions(CHAT, api).length > 0);
  await tools.design_show.run({ id: "welcome", title: "Welcome", document: designDocument() });
  const [comment] = await api.addComments({ chatId: CHAT, comments: [{ design: { id: "welcome", version: 1 }, text: "Bigger" }] });
  const request = { chatId: CHAT, id: "welcome" };
  assert.equal((await api.list({ ...request, format: "design" })).length, 1);
  assert.equal((await api.comments(request)).length, 1);
  await tools.artifact_resolve_comment.run({ id: comment.id, note: "Done" });
  assert.equal((await api.comments(request))[0].resolved.note, "Done");
  const restarted = createChatArtifacts({ directory, validateChat: async () => {} });
  assert.equal((await restarted.get(request)).version, 1);
  assert.equal((await restarted.comments(request)).length, 1);
  await restarted.removeChat(CHAT);
  assert.deepEqual(await restarted.list(request), []);
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
  assert.deepEqual(
    (await api.comments({ chatId: CHAT })).map((comment) => comment.id),
    ["00000001", "00000002", "00000003"],
  );
  assert.equal((await api.list({ chatId: CHAT }))[0].id, "split");
  assert.equal((await api.get({ chatId: CHAT, id: "old", version: 1 })).html, "<p>Newer</p>");
  await api.show({ chatId: CHAT, title: "Current explanation", html: "<p>Current</p>" });
  assert.equal((await api.get({ chatId: CHAT, id: "old", version: 1 })).html, "<p>Current</p>");
  assert.equal(await fs.readFile(path.join(split, "v1.html"), "utf8"), "<p>Newer</p>", "legacy HTML remains recoverable on disk");
});

test("HTML tool updates one live page without version history", async (t) => {
  const { api, directory } = await fixture(t);
  const tools = Object.fromEntries([...htmlArtifactToolDefinitions(CHAT, api), ...artifactCommentToolDefinitions(CHAT, api)].map((tool) => [tool.name, tool]));
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

test("a page comment keeps the text near it and the spot the page finds it by, and drops an anchor that isn't one", async (t) => {
  const { api } = await fixture(t);
  const page = await api.show({ chatId: CHAT, title: "Explainer", html: "<main><p>One</p></main>" });
  const [kept, dropped] = await api.addComments({
    chatId: CHAT,
    comments: [
      { id: "aaaaaaaa", design: page, x: 0.2, y: 0.4, near: 'The "first"\n paragraph', anchor: "main:1/p:1@0.25,0.5", text: "Shorter" },
      { id: "bbbbbbbb", design: page, x: 0.2, y: 0.4, anchor: 'main:1/p:1@0.25,0.5"><script>', text: "Longer" },
    ],
  });
  assert.equal(kept.near, "The first paragraph");
  assert.equal(kept.anchor, "main:1/p:1@0.25,0.5");
  assert.equal(dropped.anchor, undefined);
  assert.equal(dropped.near, undefined);
  assert.equal((await api.comments({ chatId: CHAT }))[0].anchor, "main:1/p:1@0.25,0.5");
});

test("a shared page with Mermaid blocks carries Pele and the page helper, one without them stays as written", async (t) => {
  const { api } = await fixture(t);
  await api.show({ chatId: CHAT, title: "Routes", html: '<pre class="mermaid">flowchart LR\n  Phone --> Mac</pre>' });
  const [shared] = (await api.pageSnapshot({ chatId: CHAT, title: "Routes", kind: "artifacts" })).artifacts;
  assert.match(shared.html, /var pele=/);
  assert.match(shared.html, /milagre:artifact-page/);
  assert.ok(shared.html.length <= 1_000_000, "within the public page's limit");
  assert.ok(shared.html.endsWith('<pre class="mermaid">flowchart LR\n  Phone --> Mac</pre>'));
  await api.show({ chatId: CHAT, title: "Huge", html: `<pre class="mermaid">flowchart LR\n A --> B</pre><p>${"x".repeat(400_000)}</p>` });
  const [huge] = (await api.pageSnapshot({ chatId: CHAT, title: "Huge", kind: "artifacts" })).artifacts;
  assert.doesNotMatch(huge.html.slice(0, 200), /<script/, "past the limit the blocks show their text");
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

test("deleting a design removes every version and its comments, and its id is never reused", async (t) => {
  const { api, tools, directory } = await fixture(t);
  await api.showDesign({ chatId: CHAT, id: "a", title: "First", document: designDocument() });
  await api.showDesign({ chatId: CHAT, id: "a", title: "First", document: designDocument(), expectedVersion: 1 });
  await api.showDesign({ chatId: CHAT, id: "b", title: "Second", document: designDocument() });
  await api.addComments({
    chatId: CHAT,
    comments: [
      { design: { id: "a", version: 1 }, text: "gone" },
      { design: { id: "b", version: 1 }, text: "kept" },
    ],
  });
  assert.deepEqual(JSON.parse(await tools.design_delete.run({ id: "a" })), { id: "a" });
  assert.deepEqual(
    (await api.list({ chatId: CHAT })).map((design) => design.id),
    ["b"],
  );
  assert.deepEqual(
    (await api.comments({ chatId: CHAT })).map((comment) => comment.text),
    ["kept"],
  );
  const folder = path.join(await chatFolder(directory), "a");
  assert.deepEqual(await fs.readdir(folder), ["meta.json"]);
  for (const read of [
    api.get({ chatId: CHAT, id: "a" }),
    api.get({ chatId: CHAT, id: "a", version: 1 }),
    api.exportDesign({ chatId: CHAT, id: "a", format: "json" }),
  ])
    await assert.rejects(read, /no longer available/);
  await assert.rejects(api.apply({ chatId: CHAT, id: "a", expectedVersion: 2, operations: [{ op: "delete", id: "heading" }] }), /no longer available/);
  await assert.rejects(api.deleteDesign({ chatId: CHAT, id: "a" }), /no longer available/);
  await assert.rejects(api.showDesign({ chatId: CHAT, id: "a", title: "Again", document: designDocument() }), /was deleted/);
  // The live HTML page doesn't take the deleted id either.
  assert.notEqual((await api.show({ chatId: CHAT, id: "a", title: "Page", html: "<p>hi</p>" })).id, "a");
  const restarted = createChatArtifacts({ directory, validateChat: async () => {} });
  assert.deepEqual(
    (await restarted.list({ chatId: CHAT, format: "design" })).map((design) => design.id),
    ["b"],
  );
});

test("only a design is deleted", async (t) => {
  const { api } = await fixture(t);
  const page = await api.show({ chatId: CHAT, title: "Page", html: "<p>hi</p>" });
  await assert.rejects(api.deleteDesign({ chatId: CHAT, id: page.id }), /separate formats/);
  await api.showDesign({ chatId: CHAT, id: "a", title: "First", document: designDocument() });
  await assert.rejects(api.deleteDesign({ chatId: "/repo#4", id: "a" }), /no longer available/);
  assert.equal((await api.list({ chatId: CHAT, format: "design" })).length, 1);
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
  assert.deepEqual(
    schemas.design_apply.properties.operations.items.oneOf.map((item) => item.properties.op.const),
    ["update", "insert", "delete"],
  );
  assert.deepEqual(schemas.design_export.properties.format.enum, ["json", "svg"]);
  assert.equal(tools.design_show.readOnly, false);
  assert.equal(tools.design_apply.readOnly, false);
  assert.equal(tools.design_read.readOnly, true);
  assert.equal(tools.design_export.readOnly, true);
  assert.equal(tools.design_delete.readOnly, false);
});

test("a design keeps its group through revisions and edits until a revision names another", async (t) => {
  const { api, tools } = await fixture(t);
  const shown = firstLine(await tools.design_show.run({ id: "welcome", title: "Welcome", group: " Onboarding ", document: designDocument() }));
  assert.equal(shown.group, "Onboarding");
  const revised = firstLine(await tools.design_show.run({ id: "welcome", title: "Welcome", expectedVersion: 1, document: designDocument() }));
  assert.equal(revised.group, "Onboarding", "a revision without a group stays in its group");
  const edited = firstLine(
    await tools.design_apply.run({ id: "welcome", expectedVersion: 2, operations: [{ op: "update", id: "heading", patch: { text: "Hi" } }] }),
  );
  assert.equal(edited.group, "Onboarding");
  const shared = await api.pageSnapshot({ chatId: CHAT, title: "Designs" });
  assert.equal(shared.designs.find((design) => design.title === "Welcome")?.group, "Onboarding", "the public page keeps the block");
  assert.equal((await api.list({ chatId: CHAT, format: "design" }))[0].group, "Onboarding");
  assert.equal((await api.get({ chatId: CHAT, id: "welcome", version: 1 })).group, "Onboarding");
  const moved = firstLine(await tools.design_show.run({ id: "welcome", title: "Welcome", group: "Settings", expectedVersion: 3, document: designDocument() }));
  assert.equal(moved.group, "Settings");
  const ungrouped = firstLine(await tools.design_show.run({ id: "welcome", title: "Welcome", group: "", expectedVersion: 4, document: designDocument() }));
  assert.equal(ungrouped.group, undefined, "an empty group takes the design out of its group");
  const other = firstLine(await tools.design_show.run({ id: "other", title: "Other", document: designDocument() }));
  assert.equal(other.group, undefined);
  assert.equal(z.toJSONSchema(z.object(tools.design_show.input)).properties.group.maxLength, 60);
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
  assert.doesNotMatch(svg.content, /@font-face/, "fonts are not embedded in the agent's export");
  assert.ok(svg.content.length < 20_000, `the agent's SVG stays small (${svg.content.length} characters)`);
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

test("the agent is told which fonts its image draws in Inter", async (t) => {
  const { tools, api } = await fixture(t);
  const stock = await tools.design_show.run({ id: "stock", title: "Stock", document: createExampleDesign() });
  assert.match(stock.text, /\nYour image shows .*Georgia.* in Inter; the user sees the real font\.(\n|$)/);
  const inter = await tools.design_show.run({ id: "inter", title: "Inter", document: designDocument() });
  assert.doesNotMatch(inter.text, /Your image shows/);
  const hidden = designDocument();
  hidden.nodes.push({ id: "serif", type: "text", hidden: true, width: 100, height: 20, text: "x", fontFamily: "Georgia, serif" });
  assert.doesNotMatch((await tools.design_show.run({ id: "hidden", title: "Hidden", document: hidden })).text, /Your image shows/);
  // A catalog family is drawn in the agent's image too, and embedded in the saved HTML.
  const catalog = designDocument();
  catalog.nodes.push({ id: "display", type: "text", width: 200, height: 40, text: "Nove", fontFamily: "Bebas Neue, Arial, sans-serif" });
  assert.doesNotMatch((await tools.design_show.run({ id: "catalog", title: "Catalog", document: catalog })).text, /Your image shows/);
  assert.match((await api.get({ chatId: CHAT, id: "catalog" })).html, /@font-face\{font-family:"Bebas Neue"/);
  const failing = Object.fromEntries(
    artifactToolDefinitions(CHAT, (await fixture(t)).api, undefined, {
      renderPng: async () => {
        throw "plain string";
      },
    }).map((tool) => [tool.name, tool]),
  );
  const none = await failing.design_show.run({ id: "stock", title: "Stock", document: createExampleDesign() });
  assert.doesNotMatch(none.text, /Your image shows/);
  assert.match(none.text, /preview could not be rendered: plain string/);
});

test("a failing layout check still saves and returns the design with a note", async (t) => {
  const { api } = await fixture(t);
  const tools = Object.fromEntries(
    artifactToolDefinitions(CHAT, api, undefined, {
      warnings: () => {
        throw new Error("measure failed");
      },
    }).map((tool) => [tool.name, tool]),
  );
  const shown = await tools.design_show.run({ id: "welcome", title: "Welcome", document: designDocument() });
  assert.deepEqual(firstLine(shown).warnings, []);
  assert.match(shown.text, /\nLayout warnings could not be computed: measure failed\./);
  assert.equal(shown.images.length, 1);
  assert.equal((await api.get({ chatId: CHAT, id: "welcome" })).version, 1);
});

test("the summary JSON carries at most 20 warnings and their total", async (t) => {
  const { tools } = await fixture(t);
  const document = designDocument();
  for (let index = 0; index < 25; index++) {
    document.nodes.push({ id: `off${index}`, type: "rectangle", x: 1000, y: 10 * index, width: 40, height: 8, fill: "#ff0000" });
  }
  const shown = await tools.design_show.run({ id: "many", title: "Many", document });
  const summary = firstLine(shown);
  assert.equal(summary.warnings.length, 20);
  assert.equal(summary.warningCount, 25);
  assert.match(shown.text, /…and 5 more/);
  const few = firstLine(await tools.design_show.run({ id: "few", title: "Few", document: designDocument() }));
  assert.equal(few.warningCount, undefined);
});

test("remote images are listed as notes, outside the warnings the agent must fix", async (t) => {
  const { tools } = await fixture(t);
  const document = designDocument();
  document.nodes.push(
    { id: "hero", type: "image", x: 24, y: 300, width: 342, height: 160, src: "https://example.com/hero.png" },
    { id: "off", type: "rectangle", x: 1000, y: 10, width: 40, height: 8, fill: "#ff0000" },
  );
  const shown = await tools.design_show.run({ id: "remote", title: "Remote", document });
  assert.deepEqual(
    firstLine(shown)
      .warnings.map((warning) => warning.kind)
      .sort(),
    ["off-canvas", "remote-image"],
  );
  const [, warnings = "", notes = ""] = /\nWarnings:\n([\s\S]*?)(?:\nNotes:\n([\s\S]*))?$/.exec(shown.text) ?? [];
  assert.match(warnings, /"off" extends past/);
  assert.doesNotMatch(warnings, /remote URL/);
  assert.match(notes, /Image "hero" is a remote URL/);
  assert.match(shown.text, /every item under Warnings/);
});

test("the agent is told which text layers its image leaves blank", async (t) => {
  const { api, tools } = await fixture(t);
  const document = designDocument();
  document.nodes.push(
    { id: "polish", type: "text", x: 24, y: 300, width: 300, height: 30, text: "Zażółć ✓" },
    { id: "latin", type: "text", x: 24, y: 340, width: 300, height: 30, text: "Café — naïve “quotes” → 5 €\ttab" },
    { id: "hiddenStar", type: "text", x: 24, y: 380, width: 300, height: 30, text: "★", hidden: true },
  );
  const shown = await tools.design_show.run({ id: "glyphs", title: "Glyphs", document });
  assert.match(
    shown.text,
    /\nYour image can't draw some characters in "polish"; they are blank and the line may look cut there, but the user sees them\.(\n|$)/,
  );
  assert.doesNotMatch((await tools.design_show.run({ id: "plain", title: "Plain", document: designDocument() })).text, /can't draw/);

  const many = designDocument();
  for (const [index, text] of ["Привет", "日本語", "😀", "★", "ł", "ś", "✓"].entries())
    many.nodes.push({ id: `t${index}`, type: "text", x: 24, y: 300 + index * 30, width: 300, height: 30, text });
  assert.match((await tools.design_show.run({ id: "many", title: "Many", document: many })).text, /in "t0", "t1", "t2", "t3", "t4" and 2 more;/);

  const failing = Object.fromEntries(
    artifactToolDefinitions(CHAT, api, undefined, {
      renderPng: async () => {
        throw new Error("no wasm");
      },
    }).map((tool) => [tool.name, tool]),
  );
  assert.doesNotMatch((await failing.design_show.run({ id: "glyphs2", title: "Glyphs", document })).text, /can't draw/);
});

test("the design tools tell any agent, a subagent too, to design on the Chat's canvas and keep ids for revisions", async (t) => {
  const { tools } = await fixture(t);
  assert.match(
    tools.design_show.description,
    /^For any UI, screen, mockup or visual design in this Chat, subagents included: use this, not HTML or image files/,
  );
  assert.match(tools.design_show.description, /bundled design skill \(.+SKILL\.md\)/);
  assert.match(tools.design_show.description, /to revise a design, keep its id/);
  assert.match(tools.design_apply.description, /^Revise a design on this Chat's Designs canvas, keeping its id; any agent or subagent/);
});

test("page snapshots capture every design beyond the former 20-design cap", async (t) => {
  const { api, tools } = await fixture(t);
  await assert.rejects(api.pageSnapshot({ chatId: CHAT, title: "Designs" }), /at least one design/);
  for (let i = 0; i < 21; i++) {
    await tools.design_show.run({ id: `design-${i}`, title: `Design ${i + 1}`, document: designDocument() });
  }
  const snapshot = await api.pageSnapshot({ chatId: CHAT, title: "Designs" });
  assert.equal(snapshot.designs.length, 21);
  assert.equal(new Set(snapshot.designs.map((design) => design.title)).size, 21);
  assert.ok(snapshot.designs.some((design) => design.title === "Design 21"));
});

test("a page split into tabs keeps each tab, changes one tab at a time and is published with its tab bar", async (t) => {
  const { api, directory } = await fixture(t);
  const tools = Object.fromEntries(htmlArtifactToolDefinitions(CHAT, api).map((tool) => [tool.name, tool]));
  const tabs = [
    { id: "overview", title: "Overview", html: "<p>Overview</p>" },
    { id: "data", title: "Data", html: "<p>Data</p>" },
  ];
  const first = JSON.parse(await tools.artifact_show.run({ title: "Report", tabs }));
  const page = await api.get({ chatId: CHAT, id: first.id });
  assert.deepEqual(page.tabs, tabs);
  assert.equal(page.html, "<p>Overview</p>", "viewers from before tabs see the first tab");
  // A tab without html keeps what it has; the agent reads one tab at a time.
  await tools.artifact_show.run({
    title: "Report",
    tabs: [
      { id: "overview", title: "Summary" },
      { ...tabs[1], html: "<p>More data</p>" },
    ],
  });
  const one = JSON.parse(await tools.artifact_read.run({ id: first.id, tab: "data" }));
  assert.deepEqual(one.tabs, [
    { id: "overview", title: "Summary" },
    { id: "data", title: "Data" },
  ]);
  assert.deepEqual(one.tab, { id: "data", title: "Data", html: "<p>More data</p>" });
  assert.equal(one.html, undefined);
  assert.equal(JSON.parse(await tools.artifact_read.run({ id: first.id })).tabs[0].html, "<p>Overview</p>");
  await assert.rejects(tools.artifact_read.run({ id: first.id, tab: "gone" }), /no tab gone/);
  const folder = path.join(directory, require("node:crypto").createHash("sha256").update(CHAT).digest("hex").slice(0, 32), first.id);
  assert.deepEqual((await fs.readdir(folder)).sort(), ["meta.json", "v2.html", "v2.tabs.json"], "only the current page is kept");

  const [shared] = (await api.pageSnapshot({ chatId: CHAT, title: "Report", kind: "artifacts" })).artifacts;
  assert.match(shared.html, /role="tablist"/);
  assert.match(shared.html, />Summary<\/button><button type="button" role="tab">Data</);
  assert.ok(shared.html.includes("\\u003cp>More data\\u003c/p>"), "tab pages can't close the script that carries them");

  // New tabs need their HTML; ids are unique; the page is html or tabs.
  await assert.rejects(api.show({ chatId: CHAT, title: "Report", tabs: [{ id: "new", title: "New" }] }), /needs its HTML/);
  await assert.rejects(api.show({ chatId: CHAT, title: "Report", tabs: [tabs[0], tabs[0]] }), /Two tabs/);
  await assert.rejects(api.show({ chatId: CHAT, title: "Report", html: "<p>x</p>", tabs }), /not both/);
  await assert.rejects(
    api.show({
      chatId: CHAT,
      title: "Report",
      tabs: [
        { ...tabs[0], html: "a".repeat(600_000) },
        { ...tabs[1], html: "a".repeat(600_000) },
      ],
    }),
    /together/,
  );

  // A comment names its tab; html again drops the tabs.
  const [comment] = await api.addComments({
    chatId: CHAT,
    comments: [{ design: page, x: 0.1, y: 0.2, tab: { id: "data", title: 'The "data"' }, text: "More" }],
  });
  assert.deepEqual(comment.tab, { id: "data", title: 'The "data"' });
  const [bad] = await api.addComments({ chatId: CHAT, comments: [{ design: page, tab: { id: "../x", title: "X" }, text: "Dropped" }] });
  assert.equal(bad.tab, undefined);
  await api.show({ chatId: CHAT, title: "Report", html: "<p>One page</p>" });
  assert.equal((await api.get({ chatId: CHAT, id: first.id })).tabs, undefined);
  assert.deepEqual((await fs.readdir(folder)).sort(), ["meta.json", "v3.html"]);
});

test("a page shows files the agent attaches from the Chat's Worktree, keeps them while its HTML uses them, and reads them in chunks", async (t) => {
  const { api, directory } = await fixture(t);
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-worktree-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-outside-"));
  t.after(() => Promise.all([fs.rm(worktree, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const video = Buffer.alloc(600 * 1024, 7);
  await fs.writeFile(path.join(worktree, "demo.mp4"), video);
  await fs.writeFile(path.join(worktree, "chart.png"), "png");
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  await fs.symlink(path.join(outside, "secret.txt"), path.join(worktree, "link.txt"));
  const tools = Object.fromEntries(htmlArtifactToolDefinitions(CHAT, api, undefined, { roots: async () => [worktree] }).map((tool) => [tool.name, tool]));
  const show = (args) => tools.artifact_show.run({ title: "Demo", ...args }).then(JSON.parse);

  const first = await show({
    html: '<video src="assets/demo.mp4"></video><img src="./assets/chart.png">',
    assets: [
      { name: "demo.mp4", path: path.join(worktree, "demo.mp4") },
      { name: "chart.png", path: path.join(worktree, "chart.png") },
    ],
  });
  const page = await api.get({ chatId: CHAT, id: first.id });
  const hash = require("node:crypto").createHash("sha256").update(video).digest("hex");
  assert.deepEqual(page.assets, [
    { name: "demo.mp4", hash, size: video.length, type: "video/mp4" },
    { name: "chart.png", hash: require("node:crypto").createHash("sha256").update("png").digest("hex"), size: 3, type: "image/png" },
  ]);
  assert.equal(JSON.parse(await tools.artifact_read.run({ id: first.id })).assets.length, 2);

  // Read back in chunks, the way the phone and the desktop's preview do.
  const chunk = await api.asset({ chatId: CHAT, name: "demo.mp4", offset: 0 });
  assert.equal(chunk.size, video.length);
  assert.equal(Buffer.from(chunk.base64, "base64").length, 256 * 1024);
  const tail = await api.asset({ chatId: CHAT, name: "demo.mp4", offset: 512 * 1024, length: 10 });
  assert.equal(Buffer.from(tail.base64, "base64").length, 10);
  await assert.rejects(api.asset({ chatId: CHAT, name: "demo.mp4", offset: video.length + 1 }), /offset/);
  await assert.rejects(api.asset({ chatId: CHAT, name: "missing.png" }), /no longer on the page/);
  const shared = (await api.pageSnapshot({ chatId: CHAT, title: "Demo", kind: "artifacts" })).artifacts[0];
  assert.deepEqual(shared.assets, page.assets);
  assert.equal(
    await api.assetPath({ chatId: CHAT, hash }),
    path.join(directory, require("node:crypto").createHash("sha256").update(CHAT).digest("hex").slice(0, 32), first.id, "assets", hash),
  );

  // Only regular files inside the Worktree, named without folders, used by the HTML.
  await assert.rejects(
    show({ html: '<img src="assets/s.txt">', assets: [{ name: "s.txt", path: path.join(outside, "secret.txt") }] }),
    /isn't a file in this Chat's Worktree/,
  );
  await assert.rejects(
    show({ html: '<img src="assets/l.txt">', assets: [{ name: "l.txt", path: path.join(worktree, "link.txt") }] }),
    /isn't a file in this Chat's Worktree/,
  );
  await assert.rejects(
    api.show(
      { chatId: CHAT, title: "Demo", html: '<img src="assets/a/b.png">', assets: [{ name: "a/b.png", path: path.join(worktree, "chart.png") }] },
      { roots: [worktree] },
    ),
    /no folders/,
  );
  await assert.rejects(
    show({ html: "<p>No media</p>", assets: [{ name: "chart.png", path: path.join(worktree, "chart.png") }] }),
    /doesn't use assets\/chart\.png/,
  );
  await assert.rejects(
    api.show({ chatId: CHAT, title: "Demo", html: '<img src="assets/chart.png">', assets: [{ name: "chart.png", path: path.join(worktree, "chart.png") }] }),
    /isn't a file in this Chat's Worktree/,
    "without roots, nothing can be attached",
  );

  // A page that stops mentioning a file drops it, and its bytes go once no version needs them.
  await show({ html: '<img src="assets/chart.png">' });
  const kept = await api.get({ chatId: CHAT, id: first.id });
  assert.deepEqual(
    kept.assets.map((asset) => asset.name),
    ["chart.png"],
  );
  const folder = path.join(directory, require("node:crypto").createHash("sha256").update(CHAT).digest("hex").slice(0, 32), first.id, "assets");
  assert.deepEqual(await fs.readdir(folder), [kept.assets[0].hash]);
  assert.deepEqual(await fs.readdir(path.join(directory, ".incoming")), [], "nothing is left on its way in");
  await show({ html: "<p>Text only</p>" });
  assert.equal((await api.get({ chatId: CHAT, id: first.id })).assets, undefined);
  assert.deepEqual(await fs.readdir(folder), []);
});

test("opt-in design transport strips generated fonts, preserves exact HTML, and honors held keys", async (t) => {
  const { api } = await fixture(t);
  for (const [id, fontFamily] of [
    ["inter", "Inter"],
    ["catalog", "EB Garamond"],
  ]) {
    const document = designDocument();
    document.nodes[1].fontFamily = fontFamily;
    await api.showDesign({ chatId: CHAT, id, title: fontFamily, document });
    const request = { chatId: CHAT, id };
    const full = await api.get(request);
    const split = await api.get({ ...request, fonts: { have: [] } });
    assert.match(split.fontKey, /^[a-f0-9]{64}$/);
    assert.match(split.fontCss, new RegExp(`font-family:"${fontFamily}"`));
    assert.ok(split.html.length < full.html.length);
    assert.equal(split.html.replace("</head>", `<style>${split.fontCss}</style></head>`), full.html);
    const { artifactDocument } = require("@milagre/shared/artifact-document");
    assert.equal(artifactDocument(split.html).replace("</head>", `<style>${split.fontCss}</style></head>`), artifactDocument(full.html));
    const held = await api.get({ ...request, fonts: { have: [split.fontKey] } });
    assert.equal(held.html, split.html);
    assert.equal(held.fontKey, split.fontKey);
    assert.equal(held.fontCss, undefined);
    assert.deepEqual(await api.get(request), full, "disk and default callers stay unchanged");
    for (const fonts of [null, {}, { have: null }, { have: "key" }]) {
      assert.deepEqual(await api.get({ ...request, fonts }), full, "malformed inventories stay self-contained");
    }
  }
});

test("fontless designs, non-generated heads and HTML artifacts stay self-contained", async (t) => {
  const { api, directory } = await fixture(t);
  const document = designDocument();
  document.nodes = document.nodes.slice(0, 1);
  await api.showDesign({ chatId: CHAT, id: "fontless", title: "Fontless", document });
  const request = { chatId: CHAT, id: "fontless" };
  assert.deepEqual(await api.get({ ...request, fonts: { have: [] } }), await api.get(request));
  const file = path.join(await chatFolder(directory), "fontless", "v1.html");
  for (const html of [
    "<html><head><style>@font-face{custom:yes}</style></head><body></body></html>",
    '<!doctype html><html><head><style>base</style><style>@font-face{custom:yes}</style></head><body><main id="design-root">',
    '<!doctype html><html><head></head><body><style>@font-face{font-family:"Inter"}</style></body></html>',
  ]) {
    await fs.writeFile(file, html);
    const read = await api.get({ ...request, fonts: { have: [] } });
    assert.equal(read.html, html);
    assert.equal(read.fontKey, undefined);
  }
  const { designHtml } = require("@milagre/shared/design");
  const html = designHtml(designDocument());
  await fs.writeFile(
    path.join(await chatFolder(directory), "legacy.json"),
    JSON.stringify({ id: "legacy", versions: [{ version: 1, title: "Legacy", html, createdAt: 1 }] }),
  );
  const read = await api.get({ chatId: CHAT, id: "legacy", fonts: { have: [] } });
  assert.equal(read.format, "html");
  assert.equal(read.html, html);
  assert.equal(read.fontKey, undefined);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { z } = require("zod");
const { createChatArtifacts, artifactToolDefinitions } = require("./chat-artifacts.cjs");
const { createDesignKits } = require("./design-kits.cjs");
const { createDesignLibrary, withDesignLibrary, designLibraryToolDefinitions } = require("./design-library.cjs");
const { createDesignToolGroup } = require("./design-mcp-tools.cjs");

const FIRST = "/repo#3";
const SECOND = "/repo#4";
const OTHER = "/other#1";
const CHATS = new Set([FIRST, SECOND, OTHER]);
const firstLine = (result) => JSON.parse(result.text.split("\n", 1)[0]);
const layers = (heading = "Welcome") => ({
  schemaVersion: 1,
  width: 390,
  height: 844,
  nodes: [{ id: "heading", type: "text", x: 24, y: 72, width: 342, height: 48, text: heading, fontSize: 30, fill: "#16261f" }],
});
const quiet = { renderPng: async () => ({ mime: "image/png", base64: "" }), warnings: () => [], screenshot: async () => ({ png: "", consoleMessages: [] }) };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-library-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const validateChat = async (chatId) => {
    if (!CHATS.has(chatId)) throw Error("Open an existing Chat before showing a design.");
  };
  const projectForChat = async (chatId) => {
    await validateChat(chatId);
    return chatId.split("#")[0];
  };
  const kits = createDesignKits({ directory: path.join(directory, "kits"), projectForChat });
  const artifacts = createChatArtifacts({ directory: path.join(directory, "artifacts"), validateChat, readKit: (request) => kits.read(request) });
  const changes = [];
  const library = createDesignLibrary({
    directory: path.join(directory, "library"),
    projectForChat,
    chatInfo: async (chatId) => ({ title: `Chat ${chatId.split("#")[1]}`, agent: "Claude" }),
    artifacts,
    readKit: (request) => kits.readProject(request),
    onChange: ({ project }) => changes.push(project),
  });
  const designs = withDesignLibrary(artifacts, library);
  const toolsFor = (chatId) =>
    Object.fromEntries(
      [...artifactToolDefinitions(chatId, designs, undefined, quiet), ...designLibraryToolDefinitions(chatId, library)].map((tool) => [tool.name, tool]),
    );
  return { artifacts, library, designs, kits, changes, toolsFor };
}

test("a Chat design goes to the library as its own copy, and another Chat of the Project revises it with a recorded version", async (t) => {
  const { artifacts, library, designs, changes, toolsFor } = await fixture(t);
  await artifacts.showDesign({ chatId: FIRST, id: "login", title: "Login", group: "Auth", document: layers() });
  const added = JSON.parse(await toolsFor(FIRST).design_library_add.run({ designId: "login", page: "iPhone" }));
  assert.equal(added.id, "library:login");
  assert.equal(added.version, 1);
  assert.equal(added.group, "Auth", "the canvas group comes along");
  assert.deepEqual(
    added.edits.map(({ at: _at, ...edit }) => edit),
    [{ version: 1, chatId: FIRST, chat: "Chat 3", agent: "Claude" }],
  );
  assert.deepEqual(changes, ["/repo"]);

  const second = toolsFor(SECOND);
  const read = JSON.parse(await second.design_read.run({ id: "library:login" }));
  assert.equal(read.document.nodes[0].text, "Welcome");
  const applied = firstLine(
    await second.design_apply.run({ id: "library:login", expectedVersion: 1, operations: [{ op: "update", id: "heading", patch: { text: "Hello again" } }] }),
  );
  assert.equal(applied.id, "library:login");
  assert.equal(applied.version, 2);
  await assert.rejects(
    second.design_apply.run({ id: "library:login", expectedVersion: 1, operations: [{ op: "update", id: "heading", patch: { text: "Stale" } }] }),
    /version conflict/i,
  );

  const seen = await designs.get({ chatId: FIRST, id: "library:login" });
  assert.equal(seen.version, 2, "every Chat of the Project reads the latest library version");
  assert.equal(seen.document.nodes[0].text, "Hello again");
  assert.deepEqual(
    seen.edits.map((edit) => [edit.version, edit.chatId]),
    [
      [1, FIRST],
      [2, SECOND],
    ],
  );
  assert.equal((await artifacts.get({ chatId: FIRST, id: "login" })).document.nodes[0].text, "Welcome", "the Chat's own design stays as it was");
  assert.equal((await designs.get({ chatId: FIRST, id: "library:login", version: 1 })).document.nodes[0].text, "Welcome");

  const listed = await library.list({ chatId: SECOND });
  assert.deepEqual(
    listed.pages.map((page) => [page.name, page.designs.map((design) => `${design.id}@${design.version}`)]),
    [["iPhone", ["library:login@2"]]],
  );
  assert.deepEqual(await library.list({ chatId: OTHER }), { pages: [] }, "another Project has its own library");
  await assert.rejects(designs.get({ chatId: OTHER, id: "library:login" }), /isn't in the Project library/);
});

test("the HTML page goes in as an interactive design per tab, a page with files is refused, and new library ids need a library source", async (t) => {
  const { artifacts, library, toolsFor } = await fixture(t);
  const page = await artifacts.show({
    chatId: FIRST,
    title: "Report",
    tabs: [
      { id: "summary", title: "Summary", html: "<h1>Summary</h1>" },
      { id: "detail", title: "Detail", html: "<h1>Detail</h1>" },
    ],
  });
  const tools = toolsFor(FIRST);
  const added = JSON.parse(await tools.design_library_add.run({ designId: page.id, page: "Reports", tab: "detail" }));
  assert.equal(added.interactive, true);
  assert.equal(added.title, "Report · Detail");
  assert.match((await library.get({ chatId: FIRST, id: added.id })).html, /Detail/);
  await assert.rejects(tools.design_library_add.run({ designId: page.id, page: "Reports", tab: "missing" }), /no tab missing/);
  await assert.rejects(tools.design_library_add.run({ designId: added.id, page: "Reports" }), /already in the Project library/);
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "design-library-files-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.writeFile(path.join(folder, "chart.svg"), "<svg/>");
  const withFile = await artifacts.show(
    { chatId: FIRST, title: "Report", html: '<img src="assets/chart.svg">', assets: [{ name: "chart.svg", path: path.join(folder, "chart.svg") }] },
    { roots: [folder] },
  );
  await assert.rejects(tools.design_library_add.run({ designId: withFile.id, page: "Reports" }), /pages without files/);

  await assert.rejects(
    tools.design_show.run({ id: "library:fresh", title: "Fresh", document: layers() }),
    /design_library_add/,
    "design_show doesn't create library designs from nothing",
  );
  await artifacts.showDesign({ chatId: FIRST, id: "home", title: "Home", document: layers("Home") });
  await tools.design_library_add.run({ designId: "home", page: "iPhone" });
  const variant = firstLine(
    await tools.design_show.run({
      id: "library:home-dark",
      title: "Home, dark",
      from: { id: "library:home" },
      operations: [{ op: "document", patch: { background: "#111111" } }],
    }),
  );
  assert.equal(variant.id, "library:home-dark");
  assert.equal(variant.page, "iphone", "a library variant lands on its source's page");
  await assert.rejects(tools.design_show.run({ id: "copy", title: "Copy", from: { id: "library:home" } }), /can't start from a library design/);
});

test("renaming and moving keep versions, empty pages go away, pages rename, and removing reaches only the library", async (t) => {
  const { artifacts, library, designs, toolsFor } = await fixture(t);
  const tools = toolsFor(FIRST);
  for (const id of ["one", "two"]) {
    await artifacts.showDesign({ chatId: FIRST, id, title: id, document: layers(id) });
    await tools.design_library_add.run({ designId: id, page: id === "one" ? "Watch" : "Kit" });
  }
  const renamed = JSON.parse(await tools.design_library_update.run({ id: "library:one", title: "One, renamed", page: "kit" }));
  assert.equal(renamed.version, 2);
  assert.equal(renamed.title, "One, renamed");
  assert.deepEqual(
    (await library.list({ chatId: FIRST })).pages.map((page) => [page.name, page.designs.map((design) => design.id)]),
    [["Kit", ["library:one", "library:two"]]],
    "moving the last design off Watch removes the page; Kit matches whatever its case",
  );
  assert.deepEqual(JSON.parse(await tools.design_library_rename_page.run({ page: "Kit", name: "Components" })), { id: "kit", name: "Components" });
  await artifacts.showDesign({ chatId: FIRST, id: "three", title: "three", document: layers("three") });
  await tools.design_library_add.run({ designId: "three", page: "iPad" });
  await assert.rejects(tools.design_library_rename_page.run({ page: "iPad", name: "components" }), /already has a page/);

  assert.deepEqual(await designs.deleteDesign({ chatId: SECOND, id: "library:two" }), { id: "library:two" });
  assert.deepEqual(
    (await library.list({ chatId: FIRST })).pages.flatMap((page) => page.designs.map((design) => design.id)),
    ["library:one", "library:three"],
  );
  assert.equal((await artifacts.get({ chatId: FIRST, id: "two" })).version, 1, "the Chat's copy is untouched");
  await artifacts.showDesign({ chatId: FIRST, id: "two", title: "two again", expectedVersion: 1, document: layers("again") });
  const again = JSON.parse(await tools.design_library_add.run({ designId: "two", page: "Kit" }));
  assert.match(again.id, /^library:two-[a-f0-9]{6}$/, "a removed library id isn't reused");
});

test("the library outlives the Chat that made it", async (t) => {
  const { artifacts, library, toolsFor } = await fixture(t);
  await artifacts.showDesign({ chatId: FIRST, id: "keep", title: "Keep", document: layers() });
  await toolsFor(FIRST).design_library_add.run({ designId: "keep", page: "iPhone" });
  await artifacts.removeChat(FIRST);
  CHATS.delete(FIRST);
  t.after(() => CHATS.add(FIRST));
  const listed = await library.list({ chatId: SECOND });
  assert.deepEqual(
    listed.pages[0].designs.map((design) => design.id),
    ["library:keep"],
  );
  await assert.rejects(library.list({ chatId: FIRST }), /existing Chat/);
});

test("library refs pass the tool schemas, and an explicit design grant still refuses them", async (t) => {
  const { artifacts, designs, toolsFor } = await fixture(t);
  const tools = toolsFor(FIRST);
  assert.equal(z.object(tools.design_read.input).safeParse({ id: "library:login" }).success, true);
  assert.equal(z.object(tools.design_read.input).safeParse({ id: "library:../x" }).success, false);
  assert.equal(z.object(tools.design_library_update.input).safeParse({ id: "login" }).success, false);
  await artifacts.showDesign({ chatId: FIRST, id: "granted", title: "Granted", document: layers() });
  await tools.design_library_add.run({ designId: "granted", page: "iPhone" });
  const group = createDesignToolGroup({ artifacts: designs });
  const scoped = Object.fromEntries(
    group.tools({ scope: { chatId: FIRST, designIds: ["granted"], capabilities: ["read"] }, assertActive: () => {} }).map((tool) => [tool.name, tool]),
  );
  await assert.rejects(scoped.design_read.run({ id: "library:granted" }), /outside the connection's scope/);
  const open = Object.fromEntries(
    group.tools({ scope: { chatId: FIRST, designIds: "*", capabilities: ["read"] }, assertActive: () => {} }).map((tool) => [tool.name, tool]),
  );
  assert.equal(JSON.parse(await open.design_read.run({ id: "library:granted" })).id, "library:granted");
});

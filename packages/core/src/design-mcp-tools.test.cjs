const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createChatArtifacts } = require("./chat-artifacts.cjs");
const { createDesignToolGroup } = require("./design-mcp-tools.cjs");
const firstLine = (result) => JSON.parse(result.text.split("\n", 1)[0]);
const document = { schemaVersion: 1, width: 390, height: 844, nodes: [] };
async function fixture(t, designIds = ["allowed"], capabilities = ["read", "write"]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-mcp-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const chatId = "/private/project#1";
  const artifacts = createChatArtifacts({ directory, validateChat: async (id) => assert.equal(id, chatId) });
  for (const id of ["allowed", "outside"]) await artifacts.showDesign({ chatId, id, title: id, document });
  const comments = await artifacts.addComments({
    chatId,
    comments: ["allowed", "outside"].map((id) => ({ design: { id, version: 1, title: id }, text: "Change this" })),
  });
  const group = createDesignToolGroup({ artifacts });
  let revoked = false;
  const scope = { chatId, designIds, capabilities };
  const assertActive = () => {
    if (revoked) throw Error("Connection revoked");
  };
  const tools = Object.fromEntries(group.tools({ scope, assertActive }).map((tool) => [tool.name, tool]));
  return {
    artifacts,
    comments,
    group,
    tools,
    scope,
    assertActive,
    revoke: () => {
      revoked = true;
    },
  };
}
test("design-only adapter lists and reads only explicitly granted designs", async (t) => {
  const { tools } = await fixture(t);
  assert.deepEqual(
    JSON.parse(await tools.design_list.run({})).map((item) => item.id),
    ["allowed"],
  );
  assert.equal(JSON.parse(await tools.design_read.run({ id: "allowed" })).id, "allowed");
  assert.equal(tools.project_list, undefined);
  assert.equal(tools.design_publish, undefined);
  await assert.rejects(tools.design_read.run({ id: "outside" }), /outside/);
  await assert.rejects(tools.design_read.run({ id: "allowed", chatId: "/other#2" }), /Unrecognized key/);
  await assert.rejects(tools.design_show.run({ title: "Implicit", document }), /outside/);
  await assert.rejects(tools.design_show.run({ id: "outside", title: "Other", document, expectedVersion: 1 }), /outside/);
  assert.equal(firstLine(await tools.design_show.run({ id: "allowed", title: "Revised", document, expectedVersion: 1 })).version, 2);
});
test("comment scope follows the comment's design, not the comment ID", async (t) => {
  const { tools, comments, artifacts, scope } = await fixture(t);
  assert.equal(JSON.parse(await tools.artifact_comments.run({})).length, 1);
  await assert.rejects(tools.artifact_resolve_comment.run({ id: comments[1].id, note: "Done" }), /outside/);
  await tools.artifact_resolve_comment.run({ id: comments[0].id, note: "Done" });
  const result = await artifacts.comments({ chatId: scope.chatId });
  assert.equal(result[0].resolved.note, "Done");
  assert.equal(result[1].resolved, undefined);
});
test("revocation and capabilities govern already cached tool calls", async (t) => {
  const { tools, revoke } = await fixture(t);
  revoke();
  await assert.rejects(
    tools.design_apply.run({
      id: "allowed",
      expectedVersion: 1,
      operations: [{ op: "insert", node: { id: "box", type: "rectangle", width: 10, height: 10 } }],
    }),
    /revoked/,
  );
  const readOnly = await fixture(t, "*", ["read"]);
  assert.equal(readOnly.tools.design_apply, undefined);
  assert.equal(readOnly.tools.artifact_resolve_comment, undefined);
  assert.ok(readOnly.group.tools({ scope: readOnly.scope, assertActive: readOnly.assertActive }).length > 0);
  assert.equal(JSON.parse(await readOnly.tools.design_read.run({ id: "allowed" })).id, "allowed");
});
test("wildcard creation is confined to the granted Chat and empty scope grants nothing", async (t) => {
  const wildcard = await fixture(t, "*");
  const created = firstLine(await wildcard.tools.design_show.run({ title: "New", document }));
  assert.ok(created.id);
  const empty = await fixture(t, []);
  assert.deepEqual(JSON.parse(await empty.tools.design_list.run({})), []);
  await assert.rejects(empty.tools.design_show.run({ id: "allowed", title: "Denied", document }), /outside/);
  assert.throws(() => empty.group.tools({ scope: { ...empty.scope, designIds: undefined }, assertActive: empty.assertActive }), /explicit Chat/);
});

test("revoking a connection while a document read or export is running withholds its result", async (t) => {
  for (const [method, tool, input] of [
    ["get", "design_read", { id: "allowed" }],
    ["exportDesign", "design_export", { id: "allowed", format: "json" }],
  ]) {
    const { artifacts, tools, revoke } = await fixture(t);
    const original = artifacts[method];
    artifacts[method] = async (request) => {
      const result = await original(request);
      revoke();
      return result;
    };
    await assert.rejects(tools[tool].run(input), /Connection revoked/);
  }
});

test("composed registry rejects queued design and comment mutations after revocation or a grant edit", async (t) => {
  const { createLocalMcpRegistry } = require("./local-mcp-registry.cjs");
  for (const change of ["revoke", "edit"]) {
    for (const [method, name, args] of [
      ["showDesign", "design_show", { id: "allowed", title: "Changed", document, expectedVersion: 1 }],
      [
        "apply",
        "design_apply",
        { id: "allowed", expectedVersion: 1, operations: [{ op: "insert", node: { id: "box", type: "rectangle", width: 10, height: 10 } }] },
      ],
      ["resolveComment", "artifact_resolve_comment", { note: "Resolved" }],
    ]) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-mcp-queued-"));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const chatId = "/project#1";
      let hold = false;
      const blocked = Promise.withResolvers();
      const entered = Promise.withResolvers();
      const artifacts = createChatArtifacts({
        directory,
        validateChat: async () => {
          if (hold) {
            entered.resolve();
            await blocked.promise;
          }
        },
      });
      await artifacts.showDesign({ chatId, id: "allowed", title: "Original", document });
      const [comment] = await artifacts.addComments({ chatId, comments: [{ design: { id: "allowed", title: "Original", version: 1 }, text: "Change this" }] });
      let grant = { revision: 1, grants: { designs: { chatId, designIds: ["allowed"], capabilities: ["read", "write"] } } };
      const registry = createLocalMcpRegistry({
        connection: () => {
          if (!grant) throw Error("Connection revoked");
          return grant;
        },
      });
      registry.registerToolGroup(createDesignToolGroup({ artifacts }));
      const tool = registry.toolsFor("connection").find((item) => item.name === name);
      const original = artifacts[method];
      let blocker;
      artifacts[method] = (...input) => {
        hold = true;
        blocker = artifacts.list({ chatId });
        return original(...input);
      };
      const operation = tool.run(method === "resolveComment" ? { ...args, id: comment.id } : args);
      const rejected = assert.rejects(operation, /changed or revoked|Connection revoked/);
      await entered.promise;
      grant = change === "revoke" ? null : { ...grant, revision: 2 };
      hold = false;
      blocked.resolve();
      await blocker;
      await rejected;
      const saved = await artifacts.get({ chatId, id: "allowed" });
      assert.equal(saved.version, 1, `${name} cannot commit after ${change}`);
      assert.equal(saved.title, "Original");
      assert.equal((await artifacts.comments({ chatId }))[0].resolved, undefined);
      await artifacts.close();
    }
  }
});

test("external Designs adapter never exposes HTML artifacts or their comments", async (t) => {
  const { tools, artifacts, scope } = await fixture(t, "*");
  const html = await artifacts.show({ chatId: scope.chatId, title: "Private explainer", html: "<p>Explanation</p>" });
  const [comment] = await artifacts.addComments({
    chatId: scope.chatId,
    comments: [{ design: { id: html.id, version: html.version }, text: "HTML feedback" }],
  });
  assert.equal(tools.artifact_show, undefined);
  assert.equal(tools.artifact_read, undefined);
  assert.ok(JSON.parse(await tools.design_list.run({})).every((item) => item.format === "design"));
  assert.ok(JSON.parse(await tools.artifact_comments.run({ all: true })).every((item) => item.id !== comment.id));
  await assert.rejects(tools.design_read.run({ id: html.id }), /separate formats/);
  await assert.rejects(
    tools.design_apply.run({
      id: html.id,
      expectedVersion: html.version,
      operations: [{ op: "insert", node: { id: "box", type: "rectangle", width: 10, height: 10 } }],
    }),
    /separate formats/,
  );
  await assert.rejects(tools.artifact_resolve_comment.run({ id: comment.id, note: "Do not resolve" }), /outside/);
});

// design_show and design_apply advertise open layer objects and plain color strings (chat-artifacts.cjs); the server
// still checks every field.
test("the slim design tool schemas still reject bad colors, unknown fields and replace", async (t) => {
  const { tools } = await fixture(t);
  const box = { id: "box", type: "rectangle", width: 10, height: 10 };
  const apply = (expectedVersion, operations) => tools.design_apply.run({ id: "allowed", expectedVersion, operations });
  assert.equal(firstLine(await apply(1, [{ op: "insert", node: box }])).version, 2);
  await assert.rejects(apply(2, [{ op: "update", id: "box", patch: { fill: "url(evil)" } }]), /CSS color/);
  await assert.rejects(apply(2, [{ op: "update", id: "box", patch: { fill: "$missing" } }]), /token "\$missing" does not exist/);
  await assert.rejects(apply(2, [{ op: "update", id: "box", patch: { shadow: 4 } }]), /Unrecognized key/);
  await assert.rejects(apply(2, [{ op: "insert", node: { ...box, id: "other", blur: 2 } }]), /Unrecognized key/);
  await assert.rejects(apply(2, [{ op: "insert", node: { id: "other", type: "rectangle" } }]));
  await assert.rejects(apply(2, [{ op: "replace", document }]));
  const show = (node) => tools.design_show.run({ id: "allowed", title: "Changed", expectedVersion: 2, document: { ...document, nodes: [node] } });
  await assert.rejects(show({ ...box, stroke: "not a color" }), /CSS color/);
  await assert.rejects(show({ ...box, shadow: 4 }), /Unrecognized key/);
  assert.equal(JSON.parse(await tools.design_read.run({ id: "allowed" })).version, 2, "nothing rejected was saved");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createChatArtifacts } = require("./chat-artifacts.cjs");
const { createDesignToolGroup } = require("./design-mcp-tools.cjs");
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
  assert.equal(JSON.parse(await tools.design_show.run({ id: "allowed", title: "Revised", document, expectedVersion: 1 })).version, 2);
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
test("revocation, capabilities and Designs OFF govern already cached tool calls", async (t) => {
  const { tools, revoke } = await fixture(t);
  revoke();
  await assert.rejects(tools.design_apply.run({ id: "allowed", expectedVersion: 1, operations: [{ op: "replace", document }] }), /revoked/);
  const readOnly = await fixture(t, "*", ["read"]);
  assert.equal(readOnly.tools.design_apply, undefined);
  assert.equal(readOnly.tools.artifact_resolve_comment, undefined);
  await readOnly.artifacts.setEnabled(false);
  assert.deepEqual(readOnly.group.tools({ scope: readOnly.scope, assertActive: readOnly.assertActive }), []);
  await assert.rejects(readOnly.tools.design_read.run({ id: "allowed" }), /Designs are off/);
});
test("wildcard creation is confined to the granted Chat and empty scope grants nothing", async (t) => {
  const wildcard = await fixture(t, "*");
  const created = JSON.parse(await wildcard.tools.design_show.run({ title: "New", document }));
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

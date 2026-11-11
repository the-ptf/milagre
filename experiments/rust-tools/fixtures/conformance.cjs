const fs = require("node:fs/promises");
const path = require("node:path");
const { createCommandDispatcher } = require("../../../packages/core/src/command-dispatcher.cjs");
const { createChatArtifacts, artifactToolDefinitions, htmlArtifactToolDefinitions } = require("../../../packages/core/src/chat-artifacts.cjs");
const { createDesignKits, designKitToolDefinitions } = require("../../../packages/core/src/design-kits.cjs");
const { createDesignToolGroup } = require("../../../packages/core/src/design-mcp-tools.cjs");
const { designRasterTesting } = require("../../../packages/core/src/design-raster.cjs");
const { mcpContent } = require("../../../packages/core/src/linked-tools.cjs");
const root = path.resolve(process.argv[2]);
const chatId = "/fixture#7";
const doc = {
  schemaVersion: 1,
  width: 390,
  height: 844,
  background: "#ffffff",
  nodes: [{ id: "title", type: "text", x: 20, y: 20, width: 350, height: 80, text: "Milagre", fontSize: 28, fill: "#111111" }],
};
async function main() {
  await fs.access(path.join(root, "MILAGRE-ISOLATED-COPY"));
  Date.now = () => 1000;
  const kits = createDesignKits({ directory: path.join(root, "node-kits"), projectForChat: async () => "/fixture" });
  const api = createChatArtifacts({
    directory: path.join(root, "node-artifacts"),
    validateChat: async (chat) => {
      if (chat !== chatId) throw Error("Wrong chat");
    },
    readKit: (args) => kits.read(args),
  });
  const auth = { assertActive: async () => {} };
  const definitions = () =>
    [
      ...artifactToolDefinitions(chatId, api, auth),
      ...htmlArtifactToolDefinitions(chatId, api, auth),
      ...designKitToolDefinitions(chatId, kits),
      createDesignToolGroup({ artifacts: api }).tools({ scope: { chatId, designIds: "*", capabilities: ["read"] }, assertActive: auth.assertActive })[0],
    ].filter((t) => t.name !== "design_delete");
  const dispatcher = createCommandDispatcher({ definitions });
  const actions = [
    ["artifact_list", {}],
    ["artifact_comments", {}],
    ["design_list", {}],
    ["design_kit_read", {}],
    ["design_read", { id: "missing" }],
    ["artifact_read", { id: "missing" }],
    ["design_show", { id: "screen", title: "Welcome", document: doc }],
    ["__seed_comments", {}],
    ["artifact_comments", {}],
    ["artifact_resolve_comment", { id: "12345678", note: "Fixed" }],
    ["artifact_comments", {}],
    ["artifact_comments", { all: true }],
    ["design_read", { id: "screen" }],
    ["design_list", {}],
    ["design_inspect", { id: "screen" }],
    ["design_inspect", { id: "screen", nodeId: "title" }],
    ["design_inspect", { id: "screen", nodeId: "missing" }],
    ["design_export", { id: "screen", format: "json" }],
    ["design_export", { id: "screen", format: "svg" }],
    ["design_validate", { document: doc }],
    [
      "design_validate",
      {
        id: "screen",
        expectedVersion: 1,
        operations: [{ op: "update", id: "title", patch: { text: "Hi" } }],
        intent: { mode: "text-only", textIds: ["title"] },
      },
    ],
    [
      "design_apply",
      {
        id: "screen",
        expectedVersion: 1,
        operations: [{ op: "update", id: "title", patch: { text: "Hello" } }],
        intent: { mode: "text-only", textIds: ["title"] },
      },
    ],
    ["design_apply", { id: "screen", expectedVersion: 1, operations: [{ op: "delete", id: "title" }] }],
    [
      "design_show",
      { id: "variant", title: "Variant", from: { id: "screen", version: 1 }, operations: [{ op: "update", id: "title", patch: { text: "Variant" } }] },
    ],
    ["design_read", { id: "screen", version: 1 }],
    ["design_show", { id: "screen", title: "Unread revision", document: doc }],
    ["design_validate", {}],
    ["design_validate", { document: doc, id: "screen" }],
    ["design_validate", { id: "screen", expectedVersion: 99, operations: [{ op: "delete", id: "title" }] }],
    ["artifact_show", { title: "Report", html: "<h1>Report</h1>" }],
    ["artifact_list", {}],
    ["artifact_read", { id: "$INLINE" }],
    [
      "artifact_show",
      {
        title: "Tabbed",
        tabs: [
          { id: "one", title: "One", html: "<p>First</p>" },
          { id: "two", title: "Two", html: "<p>Second</p>" },
        ],
      },
    ],
    ["artifact_read", { id: "$INLINE", tab: "two" }],
    ["artifact_read", { id: "$INLINE", tab: "absent" }],
    ["artifact_resolve_comment", { id: "12345678-1234-1234-1234-123456789abc", note: "Done" }],
    ["design_kit_save", { expectedVersion: 0, kit: { title: "Fixture", colors: { ink: "#111111" }, textStyles: {}, spacing: {}, radii: {} } }],
    ["design_kit_read", {}],
    ["design_kit_save", { expectedVersion: 0, kit: { title: "Fixture", colors: {}, textStyles: {}, spacing: {}, radii: {} } }],
    [
      "design_show",
      {
        id: "warn",
        title: "Warnings",
        document: {
          ...doc,
          nodes: [
            { ...doc.nodes[0], width: 12, height: 10, fontFamily: "Unbundled", text: "Long text 🌟" },
            { id: "remote", type: "image", x: 10, y: 200, width: 100, height: 100, src: "https://example.invalid/image.png" },
          ],
        },
      },
    ],
  ];
  for (const name of ["design_read", "artifact_comments", "design_show", "design_apply", "design_export", "artifact_show", "design_kit_read"]) {
    actions.push([name, {}], [name, { unexpected: true }]);
  }
  actions.push(
    ["design_read", { id: 3 }],
    ["design_read", { id: "UPPER" }],
    ["design_read", { id: "screen", version: 0 }],
    ["design_read", { id: "screen", version: 1.5 }],
    ["artifact_comments", { all: "yes" }],
    ["artifact_show", { title: "", html: "ok" }],
  );
  actions.push(
    ["artifact_show", { title: "😀".repeat(120), html: "<p>unicode title</p>" }],
    ["artifact_show", { title: "😀".repeat(121), html: "<p>too long</p>" }],
  );
  actions.push(
    ["design_read", { id: "screen", version: 9007199254740992 }],
    ["design_kit_save", { expectedVersion: 1, kit: { title: "Fixture", colors: {}, spacing: { "#": 3 }, textStyles: {}, radii: {} } }],
  );
  const output = [];
  let inline;
  for (const [name, args] of actions) {
    if (name === "__seed_comments") {
      const comments = await api.addComments({
        chatId,
        comments: [{ id: "12345678", design: { id: "screen", version: 1, title: "Welcome" }, nodeId: "title", text: "Please fix", x: 0.5, y: 0.2 }],
      });
      output.push({ seedComments: comments });
      continue;
    }
    const input = JSON.parse(JSON.stringify(args).replaceAll("$INLINE", inline ?? "none"));
    const result = await dispatcher.run({}, name, input);
    const wire = { content: mcpContent(result), isError: result.isError };
    if (name === "artifact_show" && !wire.isError && !inline) inline = JSON.parse(wire.content[0].text).id;
    output.push({ name, args, result: wire });
  }
  process.stdout.write(JSON.stringify({ actions: output, inline }).replaceAll(inline, "$INLINE"));
  await kits.close();
}
main()
  .finally(() => designRasterTesting.retire())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });

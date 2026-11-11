/* eslint-disable no-underscore-dangle -- Snapshot Zod object parsing modes for the native tool contract. */
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { createCommandDispatcher } = require("../../../packages/core/src/command-dispatcher.cjs");
const { artifactToolDefinitions, htmlArtifactToolDefinitions } = require("../../../packages/core/src/chat-artifacts.cjs");
const { designKitToolDefinitions } = require("../../../packages/core/src/design-kits.cjs");
const { createDesignToolGroup } = require("../../../packages/core/src/design-mcp-tools.cjs");
const { BUNDLED_SKILLS_DIRECTORY } = require("../../../packages/core/src/bundled-skills.cjs");
const definitions = () => [
  ...artifactToolDefinitions("fixture", {}),
  ...htmlArtifactToolDefinitions("fixture", {}),
  ...designKitToolDefinitions("fixture", {}),
  createDesignToolGroup({ artifacts: {} }).tools({ scope: { chatId: "fixture", designIds: "*", capabilities: ["read"] }, assertActive: () => {} })[0],
];
const files = ["command-dispatcher.cjs", "chat-artifacts.cjs", "design-kits.cjs", "design-mcp-tools.cjs", "local-mcp-server.cjs"];
const sources = Object.fromEntries(
  files.map((name) => [
    name,
    createHash("sha256")
      .update(fs.readFileSync(require.resolve(`../../../packages/core/src/${name}`)))
      .digest("hex"),
  ]),
);
const { DESIGN_CATALOG_FAMILIES, designInterHasGlyph } = require("@milagre/shared/design");
const { DESIGN_ASCII_CHARACTERS, DESIGN_EXTRA_CHARACTERS } = require("../../../packages/shared/src/design-font-characters.mjs");
const glyphs = [...(DESIGN_ASCII_CHARACTERS + DESIGN_EXTRA_CHARACTERS + "\n\r\t")].filter(designInterHasGlyph).join("");
const { z } = require("zod");
const parsing = Object.fromEntries(
  definitions().map((tool) => [
    tool.name,
    z.toJSONSchema(z.strictObject(tool.input), {
      override: ({ zodSchema, jsonSchema }) => {
        if (zodSchema._zod.def.type === "object")
          jsonSchema["x-object-mode"] =
            zodSchema._zod.def.catchall?._zod.def.type === "never" ? "strict" : zodSchema._zod.def.catchall ? "passthrough" : "strip";
      },
    }),
  ]),
);
const value = { parsing, tools: createCommandDispatcher({ definitions }).list({}), sources, families: DESIGN_CATALOG_FAMILIES, glyphs };
process.stdout.write(JSON.stringify(value).replaceAll(BUNDLED_SKILLS_DIRECTORY, "$BUNDLED_SKILLS"));

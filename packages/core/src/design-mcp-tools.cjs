const { z } = require("zod");
const { artifactToolDefinitions } = require("./chat-artifacts.cjs");

/** The local MCP registry owns grants and transport. This adapter owns resource scope. */
function createDesignToolGroup({ artifacts }) {
  return {
    id: "designs",
    enabled: () => artifacts.enabled(),
    tools: ({ scope, assertActive }) => {
      if (!artifacts.enabled()) return [];
      if (
        !scope ||
        typeof scope.chatId !== "string" ||
        !scope.chatId ||
        (scope.designIds !== "*" &&
          (!Array.isArray(scope.designIds) || scope.designIds.some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))))
      )
        throw Error("A Designs connection needs an explicit Chat and design scope.");
      const chatId = scope.chatId;
      const ids = scope.designIds === "*" ? null : new Set(scope.designIds);
      const capabilities = new Set(scope.capabilities ?? []);
      const active = async (capability) => {
        await assertActive();
        if (!artifacts.enabled()) throw Error("Designs are off in Settings > Milagre.");
        if (!capabilities.has(capability)) throw Error("This connection does not grant that Designs capability.");
      };
      const permit = (id) => {
        if (ids && !ids.has(id)) throw Error("This design is outside the connection's scope.");
      };
      const tools = artifactToolDefinitions(chatId, artifacts, { assertActive: () => active("write") }).map((tool) => {
        const capability = tool.readOnly ? "read" : "write";
        return {
          ...tool,
          capability,
          run: async (input) => {
            const args = z.object(tool.input).strict().parse(input);
            await active(capability);
            if (tool.name === "artifact_comments") {
              const comments = await artifacts.comments({ chatId, format: "design" });
              await active(capability);
              return JSON.stringify(comments.filter((comment) => (!ids || ids.has(comment.design.id)) && (args.all || !comment.resolved)));
            }
            if (tool.name === "artifact_resolve_comment") {
              const comments = await artifacts.comments({ chatId, format: "design" });
              const comment = comments.find((item) => item.id === args.id && (!ids || ids.has(item.design.id)));
              if (!comment) throw Error("This comment is outside the connection's scope or is unavailable.");
              await active(capability);
            } else permit(args.id);
            const result = await tool.run(args);
            if (tool.readOnly) await active(capability);
            return result;
          },
        };
      });
      tools.unshift({
        name: "design_list",
        description: "List the structured designs in the Chat granted to this local connection.",
        input: {},
        readOnly: true,
        capability: "read",
        run: async (input) => {
          z.object({}).strict().parse(input);
          await active("read");
          const designs = await artifacts.list({ chatId, format: "design" });
          await active("read");
          return JSON.stringify(designs.filter((design) => !ids || ids.has(design.id)));
        },
      });
      return tools.filter((tool) => capabilities.has(tool.capability));
    },
  };
}
module.exports = { createDesignToolGroup };

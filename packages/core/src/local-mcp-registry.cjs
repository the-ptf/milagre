const { z } = require("zod");

function createLocalMcpRegistry({ connection }) {
  const groups = new Map();
  return {
    registerToolGroup(group) {
      if (groups.has(group.id)) throw Error(`Duplicate MCP group: ${group.id}`);
      groups.set(group.id, group);
    },
    groups: () => [...groups.values()].map((group) => ({ id: group.id, enabled: group.enabled() })),
    toolsFor(id) {
      const grant = connection(id);
      const tools = [];
      for (const group of groups.values()) {
        const scope = grant.grants[group.id];
        if (!scope || !group.enabled()) continue;
        const assertActive = () => {
          const latest = connection(id);
          if (latest.revision !== grant.revision) throw Error("Connection changed or revoked; list tools again");
          if (!group.enabled()) throw Error("Tool group disabled");
        };
        for (const tool of group.tools({ scope: structuredClone(scope), assertActive, connectionId: id, connectionLabel: grant.label })) {
          if (!tool.capability || !scope.capabilities.includes(tool.capability)) continue;
          if (tools.some((item) => item.name === tool.name)) throw Error(`Duplicate MCP tool: ${tool.name}`);
          tools.push({
            ...tool,
            strict: true,
            run: async (input) => {
              assertActive();
              const args = z.strictObject(tool.input).parse(input ?? {});
              const result = await tool.run(args);
              assertActive();
              return result;
            },
          });
        }
      }
      return tools;
    },
  };
}
module.exports = { createLocalMcpRegistry };

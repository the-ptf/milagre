const { z } = require("zod");

/** The JSON Schema of a definition's input, for MCP's tools/list. */
function inputSchema(definition) {
  const { $schema: _schema, ...schema } = z.toJSONSchema(z.object(definition.input));
  return schema;
}

/** Runs a definition with arguments checked against its input; failures come back as the tool's error text. */
async function runTool(definition, args) {
  try {
    const parsed = (definition.strict ? z.strictObject(definition.input) : z.object(definition.input)).parse(args ?? {});
    const result = await definition.run(parsed);
    // Only a design-style result ({ text, images }) carries images; an array or any other value is plain text.
    if (result && typeof result === "object" && !Array.isArray(result) && "text" in result)
      return { text: String(result.text ?? ""), images: Array.isArray(result.images) ? result.images : [], isError: false };
    return { text: String(result), images: [], isError: false };
  } catch (error) {
    const text =
      error instanceof z.ZodError
        ? `Invalid arguments: ${error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ")}`
        : error.message;
    return { text, images: [], isError: true };
  }
}

/** Resolve definitions on every operation: grants, feature switches and Bot ownership can change between calls. */
function createCommandDispatcher({ definitions }) {
  const find = (caller, name) => {
    const definition = definitions(caller).find((item) => item.name === name);
    if (!definition) throw new Error(`Command unavailable for this caller: ${name}`);
    return definition;
  };
  const describe = (definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: inputSchema(definition),
    annotations: { readOnlyHint: Boolean(definition.readOnly) },
  });
  return {
    list: (caller) => definitions(caller).map(describe),
    describe: (caller, name) => describe(find(caller, name)),
    async run(caller, name, args) {
      try {
        return await runTool({ ...find(caller, name), strict: true }, args);
      } catch (error) {
        return { text: error.message, images: [], isError: true };
      }
    },
  };
}

/** The owner RPC registry. Registration is also discovery; an adapter cannot omit a newly registered operation. */
function createRuntimeCommands() {
  const definitions = new Map();
  return {
    handle(name, run, metadata = {}) {
      if (definitions.has(name)) throw new Error(`Duplicate command: ${name}`);
      definitions.set(name, { name, run, ...metadata });
    },
    // Internal orchestration can reuse a handler while preserving its explicit context.
    get: (name) => definitions.get(name)?.run,
    methods: () => Object.freeze([...definitions.keys()]),
    list: () =>
      [...definitions.values()].map(({ run: _run, ...definition }) => ({
        command: definition.name.replaceAll(":", " "),
        ...require("./command-input.cjs").contractFor(definition.name),
        ...definition,
      })),
    invoke(name, args = [], context = null) {
      if (!definitions.has(name)) throw new Error(`Unknown command: ${name}`);
      if (!Array.isArray(args)) throw new Error("Command arguments must be an array");
      return definitions.get(name).run(context, ...args);
    },
  };
}

module.exports = { createCommandDispatcher, createRuntimeCommands, inputSchema, runTool };

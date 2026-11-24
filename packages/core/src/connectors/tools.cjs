const crypto = require("node:crypto");
const { z } = require("zod");

const MAX_TOOL_NAME = 64;
const MILAGRE_PREFIX = "mcp__milagre__";
const MAX_OUTPUT = 40_000;

function capName(name, max) {
  if (name.length <= max) return name;
  const hash = crypto.createHash("sha256").update(name).digest("hex").slice(0, 6);
  return `${name.slice(0, max - hash.length - 1)}_${hash}`;
}

const cleanName = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, "_");
/** The name Codex, Antigravity, Kiro and Pi see inside `milagre`. */
const milagreToolName = (id, name) => capName(`${id}__${cleanName(name)}`, MAX_TOOL_NAME - MILAGRE_PREFIX.length);
/** The name inside a connector's own server on Claude, which shows it as `mcp__<id>__<name>`. */
const serverToolName = (id, name) => capName(cleanName(name), MAX_TOOL_NAME - `mcp__${id}__`.length);

const ARGUMENTS = { arguments: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments as one object.") };

function inputOf(schema) {
  try {
    const converted = z.fromJSONSchema(schema && typeof schema === "object" ? schema : { type: "object" });
    if (converted instanceof z.ZodObject) return { input: converted.shape, wrapped: false };
  } catch {}
  return { input: ARGUMENTS, wrapped: true };
}

function toolResult(result) {
  const texts = [];
  const images = [];
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block.type === "text") texts.push(block.text);
    else if (block.type === "image") images.push({ base64: block.data, mime: block.mimeType });
    else if (block.type === "resource") texts.push(block.resource?.text ?? `${block.resource?.mimeType ?? "File"}: ${block.resource?.uri}`);
    else if (block.type === "resource_link") texts.push(`${block.name ?? "Link"}: ${block.uri}`);
    else if (block.type === "audio") texts.push(`Audio (${block.mimeType}) not shown.`);
  }
  if (!texts.length && result?.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent));
  const joined = texts.join("\n\n");
  const text = joined.length > MAX_OUTPUT ? `${joined.slice(0, MAX_OUTPUT)}\n… truncated` : joined;
  if (result?.isError) throw new Error(text || "The tool failed.");
  return { text, images };
}

function connectorToolDefinitions(connectors, context) {
  if (!context?.provider || !context.accountId) return [];
  return connectors.ready(context.provider, context.accountId).flatMap(({ connector, tools }) =>
    tools.map((tool) => {
      const { input, wrapped } = inputOf(tool.inputSchema);
      return {
        name: milagreToolName(connector.id, tool.name),
        connector: connector.id,
        serverToolName: serverToolName(connector.id, tool.name),
        description: `${connector.name}: ${tool.description || tool.annotations?.title || tool.title || tool.name}`,
        input,
        readOnly: tool.annotations?.readOnlyHint === true,
        run: async (args) => toolResult(await connectors.call(connector.id, tool.name, wrapped ? (args.arguments ?? {}) : args)),
      };
    }),
  );
}

module.exports = { connectorToolDefinitions, milagreToolName, serverToolName, toolResult };

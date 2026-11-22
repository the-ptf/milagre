const path = require("node:path");
const { writeIfChanged } = require("./pi-profile.cjs");

const TOOL_CALL_MARKER = "milagre:tool_call";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "tool_search"];

// The Pi extension Milagre loads into every Pi process. It registers the Chat's MCP servers (passed in
// MILAGRE_PI_MCP) and asks Milagre about every tool call that can change something, through Pi's RPC
// extension UI: a `select` whose title is the call as JSON. Milagre answers "allow", or "deny:<reason>".
const SOURCE = `const READ_ONLY = new Set(${JSON.stringify(READ_ONLY_TOOLS)});

export default function milagre(pi) {
  let servers = [];
  try {
    servers = JSON.parse(process.env.MILAGRE_PI_MCP || "[]");
  } catch {}
  for (const server of servers) {
    try {
      pi.registerMcpServer(server.name, server.config);
    } catch (error) {
      console.error("Milagre couldn't add the MCP server " + server.name + ": " + (error && error.message));
    }
  }
  pi.on("tool_call", async (event, ctx) => {
    if (READ_ONLY.has(event.toolName)) return;
    const title = JSON.stringify({ type: ${JSON.stringify(TOOL_CALL_MARKER)}, toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
    const answer = await ctx.ui.select(title, ["allow", "deny"]);
    if (answer === "allow") return;
    const reason = typeof answer === "string" && answer.startsWith("deny:") ? answer.slice(5) : "";
    return { block: true, reason: reason || "The user denied this in Milagre." };
  });
}
`;

/** Writes the extension into the Pi profile and returns its path. */
async function writePiExtension(profile) {
  const file = path.join(profile, "milagre-extension.mjs");
  await writeIfChanged(file, SOURCE);
  return file;
}

/** The tool call a `select` from Milagre's extension asks about, or null for any other extension dialog. */
function toolCallRequest(request) {
  if (request?.method !== "select" || typeof request.title !== "string" || !request.title.startsWith("{")) return null;
  try {
    const call = JSON.parse(request.title);
    return call?.type === TOOL_CALL_MARKER && typeof call.toolName === "string" ? call : null;
  } catch {
    return null;
  }
}

module.exports = { READ_ONLY_TOOLS, toolCallRequest, writePiExtension };

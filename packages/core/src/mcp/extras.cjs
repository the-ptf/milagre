// Chat start's read of Settings › MCP (Everywhere servers and the off list, mcp/index.cjs forSession). A failing read
// never stops a Chat; it is logged once per session with its message, so a broken mcp.json or CLI lookup isn't silent.
async function readMcpExtras(session) {
  try {
    return await session.mcpExtras();
  } catch (error) {
    if (!session.mcpExtrasWarned) {
      session.mcpExtrasWarned = true;
      console.warn("Settings › MCP servers could not be read for this Chat:", error instanceof Error ? error.message : String(error));
    }
    return null;
  }
}

module.exports = { readMcpExtras };

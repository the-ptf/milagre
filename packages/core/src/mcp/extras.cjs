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

const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { mcpContent } = require("./linked-tools.cjs");
const { createCommandDispatcher } = require("./command-dispatcher.cjs");

const MAX_BODY = 1024 * 1024;
// Design documents allow 1,000,000 UTF-16 units in their canonical JSON. A JSON encoder can escape
// each unit as six ASCII bytes; leave room for one call's arguments and JSON-RPC envelope.
const MAX_DESIGN_BODY = 6 * 1000000 + 64 * 1024;

// Codex reaches Milagre's linked tools as a streamable-HTTP MCP server named in each thread's config
// (verified with codex-cli 0.160: the per-thread `config.mcp_servers` entry is started, listed and called,
// with calls approved through elicitation in Ask mode). It listens on loopback only; each Chat has its own unguessable
// path, which is all that names the Chat. Requests are answered with plain JSON, never a stream.
function createLinkedMcpServer({ toolsFor }) {
  const commands = createCommandDispatcher({ definitions: toolsFor });
  const tokens = new Map();
  const chats = new Map();
  let listening = null;

  const server = http.createServer((request, response) => {
    const chatId = tokens.get(/^\/mcp\/([a-f0-9]+)$/.exec(request.url ?? "")?.[1]);
    if (!chatId) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let bytes = 0;
    const chunks = [];
    let rejected = false;
    const tooLarge = (limit) => {
      rejected = true;
      chunks.length = 0;
      reply(response, { jsonrpc: "2.0", id: null, error: { code: -32000, message: `Request exceeds the ${limit}-byte MCP limit.` } }, 413);
      // Drain any remaining input without retaining it, so the caller receives the JSON error.
      request.resume();
    };
    request.on("data", (chunk) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_DESIGN_BODY) return tooLarge(MAX_DESIGN_BODY);
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
      } catch {
        reply(response, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      } finally {
        chunks.length = 0;
      }
      const messages = Array.isArray(message) ? message : [message];
      // Only a single design-writing call gets the larger wire budget. Other tools and multi-call batches
      // keep their original bound; the document and operation schemas still validate the contents.
      const designCall =
        messages.length === 1 &&
        messages[0]?.method === "tools/call" &&
        ["design_show", "design_apply", "html_preview", "html_render"].includes(messages[0]?.params?.name);
      if (bytes > MAX_BODY && !designCall) return tooLarge(MAX_BODY);
      Promise.all(messages.map((item) => answer(chatId, item))).then(
        (answers) => {
          const replies = answers.filter(Boolean);
          if (!replies.length) response.writeHead(202).end();
          else reply(response, Array.isArray(message) ? replies : replies[0]);
        },
        (error) => reply(response, { jsonrpc: "2.0", id: null, error: { code: -32603, message: error.message } }),
      );
    });
    request.on("error", () => {
      chunks.length = 0;
      if (!rejected && !response.writableEnded)
        reply(response, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request was interrupted." } }, 400);
    });
    if (Number(request.headers["content-length"]) > MAX_DESIGN_BODY) tooLarge(MAX_DESIGN_BODY);
  });

  function reply(response, payload, status = 200) {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  }

  async function answer(chatId, message) {
    if (message?.id === undefined || message.id === null) return null;
    const ok = (result) => ({ jsonrpc: "2.0", id: message.id, result });
    const tools = toolsFor(chatId);
    switch (message.method) {
      case "initialize":
        return ok({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "milagre", version: "1" },
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: commands.list(chatId),
        });
      case "tools/call": {
        const tool = tools.find((item) => item.name === message.params?.name);
        if (!tool) return ok({ content: [{ type: "text", text: `Unknown tool: ${message.params?.name}` }], isError: true });
        const result = await commands.run(chatId, tool.name, message.params?.arguments);
        return ok({ content: mcpContent(result), isError: result.isError });
      }
      default:
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
  }

  return {
    /** The Chat's MCP endpoint, listening once this resolves. One per Chat for the life of the server. */
    async url(chatId) {
      // A failed listen is tried again on the next call.
      listening ??= new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      }).catch((error) => {
        listening = null;
        throw error;
      });
      const port = await listening;
      if (!chats.has(chatId)) {
        const token = randomBytes(24).toString("hex");
        tokens.set(token, chatId);
        chats.set(chatId, token);
      }
      return `http://127.0.0.1:${port}/mcp/${chats.get(chatId)}`;
    },
    close() {
      if (!listening) return Promise.resolve();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createLinkedMcpServer, MAX_BODY, MAX_DESIGN_BODY };

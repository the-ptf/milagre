const http = require("node:http");
const { mcpContent } = require("./linked-tools.cjs");
const { createCommandDispatcher } = require("./command-dispatcher.cjs");
const VERSIONS = ["2025-03-26", "2025-06-18"];
const MAX_BODY = 1024 * 1024;
// A 1,000,000 UTF-16-unit design can encode each unit as six ASCII bytes.
// Allow one design call's envelope too; all other calls keep the ordinary cap.
const MAX_DESIGN_BODY = 6 * 1000000 + 64 * 1024;

function createLocalMcpServer({ authenticate, toolsFor, internalConnection }) {
  const commands = createCommandDispatcher({ definitions: (connection) => (connection.tools ? connection.tools() : toolsFor(connection.id)) });
  let listening;
  let endpoint;
  let closing = false;
  const active = new Set();
  const server = http.createServer((request, response) => {
    const reject = (status) => {
      request.resume();
      response.writeHead(status).end();
    };
    const authority = endpoint && new URL(endpoint).host;
    if (closing) return reject(503);
    if (request.headers.host !== authority || (request.headers.origin !== undefined && request.headers.origin !== `http://${authority}`)) return reject(403);
    const internal = /^\/mcp\/([a-f0-9]{48})$/.exec(request.url ?? "");
    if (request.url !== "/mcp" && !internal) return reject(404);
    let connection;
    const resolveConnection = () =>
      internal ? internalConnection?.(internal[1]) : authenticate(/^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1]);
    try {
      connection = resolveConnection();
      if (!connection) throw Error("Unauthorized");
    } catch {
      return reject(401);
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return reject(405);
    }
    if (request.headers["mcp-protocol-version"] && !VERSIONS.includes(request.headers["mcp-protocol-version"])) return reject(400);
    if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") return reject(415);
    const accept = request.headers.accept ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return reject(406);
    let bytes = 0;
    const chunks = [];
    const tooLarge = (limit) => {
      chunks.length = 0;
      response.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: `Request exceeds the ${limit}-byte MCP limit.` },
        }),
      );
      request.resume();
    };
    request.on("data", (chunk) => {
      if (response.writableEnded) return;
      bytes += chunk.length;
      if (bytes > MAX_DESIGN_BODY) return tooLarge(MAX_DESIGN_BODY);
      chunks.push(chunk);
    });
    request.on("error", () => {
      chunks.length = 0;
      if (!response.writableEnded) reject(400);
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      try {
        const current = resolveConnection();
        if (!current || current.id !== connection.id || current.revision !== connection.revision) return reject(401);
      } catch {
        return reject(401);
      }
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        if (bytes > MAX_BODY) return tooLarge(MAX_BODY);
        return reject(400);
      } finally {
        chunks.length = 0;
      }
      const designCall =
        !Array.isArray(message) &&
        message?.method === "tools/call" &&
        ["design_show", "design_apply", "html_preview", "html_render"].includes(message?.params?.name);
      if (bytes > MAX_BODY && !designCall) return tooLarge(MAX_BODY);
      if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return reject(400);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (typeof message.id !== "string" && typeof message.id !== "number") return reject(400);
      const work = answer(connection, message).then(
        (payload) => {
          if (!response.destroyed) response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(payload));
        },
        () => {
          if (!response.destroyed) response.writeHead(403).end();
        },
      );
      active.add(work);
      void work.finally(() => active.delete(work));
    });
    if (Number(request.headers["content-length"]) > MAX_DESIGN_BODY) tooLarge(MAX_DESIGN_BODY);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  async function answer(connection, message) {
    const ok = (result) => ({ jsonrpc: "2.0", id: message.id, result });
    const tools = connection.tools ? connection.tools() : toolsFor(connection.id);
    if (message.method === "initialize")
      return ok({
        protocolVersion: VERSIONS.includes(message.params?.protocolVersion) ? message.params.protocolVersion : VERSIONS.at(-1),
        capabilities: { tools: {} },
        serverInfo: { name: "milagre", version: "1" },
      });
    if (message.method === "ping") return ok({});
    if (message.method === "tools/list")
      return ok({
        tools: commands.list(connection),
      });
    if (message.method === "tools/call") {
      const tool = tools.find((item) => item.name === message.params?.name);
      if (!tool) return ok({ content: [{ type: "text", text: "Tool unavailable for this connection" }], isError: true });
      const result = await commands.run(connection, tool.name, message.params?.arguments);
      return ok({ content: mcpContent(result), isError: result.isError });
    }
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }
  return {
    listen(port = 0) {
      if (closing) return Promise.reject(Error("Local MCP is closing"));
      listening ??= new Promise((resolve, reject) => {
        const failed = (error) => {
          listening = undefined;
          reject(error);
        };
        server.once("error", failed);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", failed);
          endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
          resolve(endpoint);
        });
      });
      return listening;
    },
    async close() {
      closing = true;
      if (!listening) return;
      await listening.catch(() => {});
      await Promise.allSettled(active);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
module.exports = { createLocalMcpServer };

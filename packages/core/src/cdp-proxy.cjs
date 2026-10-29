const http = require("node:http");
const { randomBytes, randomUUID } = require("node:crypto");
const { WebSocketServer } = require("ws");

// A Chrome DevTools endpoint for pages that have no debugging port of their own: the desktop's Browser panel pages,
// whose only debugger is Electron's webContents.debugger. It answers like a browser started with
// --remote-debugging-port (/json/version, /json/list, /devtools/page/<id>), so the browser service's adapter connects to
// it like to any other browser. It listens on loopback only, every path starts with a token made per launch, and a
// request whose Host isn't this loopback address is refused (a web page can't rebind a name onto it).
const PAGE_ID = /^[A-F0-9]{32}$/;
const MAX_MESSAGE = 4 * 1024 * 1024;

/**
 * @param {{
 *   product: string;
 *   pages: () => { id: string; title: string; url: string }[];
 *   session: (pageId: string) => { send(method: string, params?: object, sessionId?: string): Promise<unknown>; onEvent(listener: (method: string, params: unknown, sessionId?: string) => void): () => void; release(): void } | null;
 * }} options
 */
function createCdpProxy({ product, pages, session }) {
  const token = randomBytes(24).toString("hex");
  const browserId = randomUUID();
  let port = 0;
  const sockets = new Set();
  const loopbackHost = () => `127.0.0.1:${port}`;
  const prefix = `/${token}`;
  const json = (response, status, value) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer((request, response) => {
    if (request.headers.host !== loopbackHost() || request.method !== "GET") return json(response, 403, { error: "forbidden" });
    const url = request.url ?? "";
    if (url === `${prefix}/json/version`)
      return json(response, 200, {
        Browser: product,
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://${loopbackHost()}${prefix}/devtools/browser/${browserId}`,
      });
    if (url === `${prefix}/json/list` || url === `${prefix}/json`)
      return json(
        response,
        200,
        pages().map((page) => ({
          id: page.id,
          type: "page",
          title: page.title,
          url: page.url,
          webSocketDebuggerUrl: `ws://${loopbackHost()}${prefix}/devtools/page/${page.id}`,
        })),
      );
    json(response, 404, { error: "not found" });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  server.on("upgrade", (request, socket, head) => {
    const pageId = new RegExp(`^${prefix}/devtools/page/([A-F0-9]{32})$`).exec(request.url ?? "")?.[1] ?? "";
    const page = pageId && pages().some((item) => item.id === pageId) ? session(pageId) : null;
    if (request.headers.host !== loopbackHost() || request.headers.origin || !page) {
      page?.release();
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => bridge(ws, pageId, page));
  });

  function bridge(ws, pageId, page) {
    ws.pageId = pageId;
    sockets.add(ws);
    const send = (message) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const off = page.onEvent((method, params, sessionId) => send({ method, params, ...(sessionId ? { sessionId } : {}) }));
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!Number.isSafeInteger(message?.id) || typeof message.method !== "string") return;
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
      page.send(message.method, message.params && typeof message.params === "object" ? message.params : {}, sessionId).then(
        (result) => send({ id: message.id, result: result ?? {}, ...(sessionId ? { sessionId } : {}) }),
        (error) =>
          send({
            id: message.id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
            ...(sessionId ? { sessionId } : {}),
          }),
      );
    });
    ws.on("close", () => {
      sockets.delete(ws);
      off();
      page.release();
    });
  }

  return {
    /** Starts listening on a free loopback port; resolves to what the browser service needs to connect. */
    async start() {
      if (port) return { port, token, browserId };
      await /** @type {Promise<void>} */ (
        new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve());
        })
      );
      const address = server.address();
      port = address && typeof address === "object" ? address.port : 0;
      return { port, token, browserId };
    },
    /** Ends every DevTools connection to a page that is gone. */
    drop(pageId) {
      if (!PAGE_ID.test(pageId)) return;
      for (const ws of sockets) if (ws.pageId === pageId) ws.close(1001, "page closed");
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      await /** @type {Promise<void>} */ (new Promise((resolve) => server.close(() => resolve())));
    },
  };
}

module.exports = { createCdpProxy };

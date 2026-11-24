const http = require("node:http");

const CALLBACK_PATH = "/connectors/callback";
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (title, text) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Milagre</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--ink:#14161b;--ink-3:#6b7280}
@media (prefers-color-scheme:dark){:root{--bg:#0f1117;--ink:#eef0f4;--ink-3:#8b919d}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px;text-align:center}
h1{margin:0;font-size:17px;font-weight:600}
p{margin:0;color:var(--ink-3)}
</style>
<main><h1>${escape(title)}</h1><p>${escape(text)}</p></main></html>`;

class ConnectorError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const failed = (error) => reject(error);
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      resolve();
    });
  });
}

async function listenForCallback({ state, name, port, timeoutMs = 300_000 }) {
  let settle;
  const code = new Promise((resolve, reject) => (settle = { resolve, reject }));
  code.catch(() => {});
  const handle = (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const answer = (status, title, text) => response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page(title, text));
    const params = url.searchParams;
    if (params.get("state") !== state) return answer(400, "This link is out of date", "Start again from Milagre.");
    if (params.get("error")) {
      answer(200, "Sign-in cancelled", "You can close this tab.");
      settle.reject(new ConnectorError(`${name} sign-in failed: ${params.get("error_description") || params.get("error")}`, "failed"));
      return;
    }
    const value = params.get("code");
    if (!value) return answer(400, `${name} didn't send a sign-in code`, "Start again from Milagre.");
    answer(200, `Signed in to ${name}`, "You can close this tab and go back to Milagre.");
    settle.resolve(value);
  };
  const options = { requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 };
  const primary = http.createServer(options, handle);
  await listen(primary, port, "127.0.0.1").catch((error) => {
    throw error.code === "EADDRINUSE" ? new ConnectorError(`Port ${port} is in use. Close the app using it and try again.`, "failed") : error;
  });
  const bound = primary.address().port;
  const secondary = http.createServer(options, handle);
  const servers = [primary];
  const listening = await listen(secondary, bound, "::1").then(
    () => true,
    () => false,
  );
  if (listening) servers.push(secondary);
  const timer = setTimeout(() => settle.reject(new ConnectorError(`${name} sign-in timed out. Try again.`, "failed")), timeoutMs);
  timer.unref();
  let closed = null;
  const close = () =>
    (closed ??= Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    ).then(() => clearTimeout(timer)));
  return {
    redirectUri: `http://localhost:${bound}${CALLBACK_PATH}`,
    code,
    close,
    cancel() {
      settle.reject(new ConnectorError(`Replaced by a newer sign-in.`, "cancelled"));
      return close();
    },
  };
}

module.exports = { listenForCallback, ConnectorError, CALLBACK_PATH };

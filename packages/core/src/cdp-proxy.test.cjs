const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createCdpProxy } = require("./cdp-proxy.cjs");

const PAGE = "A".repeat(32);

function fixture(t) {
  const calls = [];
  const listeners = new Set();
  let released = 0;
  const proxy = createCdpProxy({
    product: "Milagre Browser panel (test)",
    pages: () => [{ id: PAGE, title: "Checkout", url: "http://localhost:5173/" }],
    session: (pageId) =>
      pageId === PAGE
        ? {
            send: async (method, params, sessionId) => {
              calls.push({ method, params, sessionId });
              if (method === "Boom.fail") throw new Error("nope");
              return { echoed: method };
            },
            onEvent: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            release: () => released++,
          }
        : null,
  });
  t.after(() => proxy.close());
  return { proxy, calls, listeners, released: () => released };
}

/** A GET with a chosen Host header (fetch won't let a test forge it). */
function get(port, path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: body ? JSON.parse(body) : null }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("the endpoint answers like a debugging browser, only on its token path and its own loopback Host", async (t) => {
  const { proxy } = fixture(t);
  const { port, token, browserId } = await proxy.start();
  const version = await get(port, `/${token}/json/version`);
  assert.equal(version.status, 200);
  assert.equal(version.body.Browser, "Milagre Browser panel (test)");
  assert.equal(version.body.webSocketDebuggerUrl, `ws://127.0.0.1:${port}/${token}/devtools/browser/${browserId}`);
  const list = await get(port, `/${token}/json/list`);
  assert.deepEqual(list.body, [
    { id: PAGE, type: "page", title: "Checkout", url: "http://localhost:5173/", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${token}/devtools/page/${PAGE}` },
  ]);
  assert.equal((await get(port, "/json/list")).status, 404);
  assert.equal((await get(port, `/${"0".repeat(48)}/json/list`)).status, 404);
  // A name rebound to 127.0.0.1 by a web page carries its own Host.
  assert.equal((await get(port, `/${token}/json/list`, `evil.example:${port}`)).status, 403);
  assert.equal((await get(port, `/${token}/json/list`, `localhost:${port}`)).status, 403, "a name, never: DNS rebinding");
  // A paired computer comes through its own loopback forwarder (panel-forwarders.cjs), with that port in Host.
  assert.equal((await get(port, `/${token}/json/list`, "127.0.0.1:61234")).status, 200);
});

test("a DevTools connection relays commands, results, errors and events, and releases the page when it closes", async (t) => {
  const f = fixture(t);
  const { port, token } = await f.proxy.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${token}/devtools/page/${PAGE}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const messages = [];
  ws.addEventListener("message", (event) => messages.push(JSON.parse(event.data)));
  ws.send(JSON.stringify({ id: 1, method: "Page.enable", params: { a: 1 } }));
  ws.send(JSON.stringify({ id: 2, method: "Boom.fail" }));
  ws.send("not json");
  // Nothing past the page: no other targets, no attached sessions.
  ws.send(JSON.stringify({ id: 3, method: "Target.getTargets" }));
  ws.send(JSON.stringify({ id: 4, method: "Runtime.evaluate", params: {}, sessionId: "MAIN-WINDOW" }));
  ws.send(JSON.stringify({ id: 5, method: "Browser.getVersion" }));
  // Nor the session's cookies: they hold the sign-ins of every Chat sharing it.
  ws.send(JSON.stringify({ id: 6, method: "Network.getAllCookies" }));
  ws.send(JSON.stringify({ id: 7, method: "Network.getCookies", params: { urls: ["https://github.com"] } }));
  ws.send(JSON.stringify({ id: 8, method: "Network.setCookie", params: { name: "a", value: "b", url: "https://github.com" } }));
  const until = async (check) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await until(() => messages.length >= 8);
  for (const id of [3, 4, 5, 6, 7, 8]) assert.equal(messages.find((message) => message.id === id)?.error?.code, -32601, `message ${id}`);
  assert.equal(f.calls.length, 2, "refused commands never reach the page");
  assert.deepEqual(f.calls[0], { method: "Page.enable", params: { a: 1 }, sessionId: undefined });
  assert.deepEqual(
    messages.find((message) => message.id === 1),
    { id: 1, result: { echoed: "Page.enable" } },
  );
  assert.deepEqual(
    messages.find((message) => message.id === 2),
    { id: 2, error: { code: -32000, message: "nope" } },
  );
  for (const listener of f.listeners) listener("Runtime.consoleAPICalled", { args: [] }, "MAIN-WINDOW");
  for (const listener of f.listeners) listener("Page.screencastFrame", { data: "jpeg", sessionId: 3 });
  await until(() => messages.some((message) => message.method));
  assert.deepEqual(
    messages.filter((message) => message.method).map((message) => message.method),
    ["Page.screencastFrame"],
    "events of attached sessions stay in Milagre",
  );
  assert.deepEqual(
    messages.find((message) => message.method),
    { method: "Page.screencastFrame", params: { data: "jpeg", sessionId: 3 } },
  );
  ws.close();
  await until(() => f.released() === 1);
  assert.equal(f.released(), 1);
  assert.equal(f.listeners.size, 0);
});

test("a page that isn't listed, a wrong token or a web page's Origin gets no DevTools connection", async (t) => {
  const f = fixture(t);
  const { port, token } = await f.proxy.start();
  const refused = (url, headers) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url, { headers });
      ws.addEventListener("open", () => resolve(false));
      ws.addEventListener("error", () => resolve(true));
    });
  assert.equal(await refused(`ws://127.0.0.1:${port}/${token}/devtools/page/${"B".repeat(32)}`), true);
  assert.equal(await refused(`ws://127.0.0.1:${port}/${"0".repeat(48)}/devtools/page/${PAGE}`), true);
  assert.equal(await refused(`ws://127.0.0.1:${port}/${token}/devtools/page/${PAGE}`, { origin: "https://evil.example" }), true);
});

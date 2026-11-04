const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCdpProxy } = require("./cdp-proxy.cjs");
const { createBrowserAdapter } = require("./browsers-cdp.cjs");

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

/** A request with a body and chosen headers. */
function put(port, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: urlPath, method: "PUT", headers: { host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("a file put on the endpoint lands in its own temp folder under its name, which goes when the proxy closes", async (t) => {
  const { proxy } = fixture(t);
  const { port, token } = await proxy.start();
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-upload-source-"));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const file = path.join(source, "Summer clip.mp4");
  fs.writeFileSync(file, Buffer.alloc(5 * 1024 * 1024, 7));
  // The host's side: the browser adapter streams the file to the page's computer.
  const placed = await createBrowserAdapter().upload({ host: "127.0.0.1", port, prefix: `/${token}` }, file);
  assert.equal(path.basename(placed), "Summer clip.mp4");
  assert.ok(placed.startsWith(os.tmpdir()) || placed.startsWith(fs.realpathSync(os.tmpdir())), placed);
  assert.ok(fs.readFileSync(placed).equals(fs.readFileSync(file)));
  // Only with the token, no web page's Origin, a plain name and an honest length.
  assert.equal((await put(port, `/${"0".repeat(48)}/files/a.txt`, "x")).status, 403);
  assert.equal((await put(port, `/${token}/files/a.txt`, "x", { origin: "https://evil.example" })).status, 403);
  assert.equal((await put(port, `/${token}/files/${encodeURIComponent("../a.txt")}`, "x")).status, 400);
  assert.equal((await put(port, `/${token}/files/..`, "x")).status, 400);
  assert.equal((await put(port, `/${token}/files/a.txt`, "x", { "transfer-encoding": "chunked" })).status, 413);
  await proxy.close();
  assert.equal(fs.existsSync(path.dirname(path.dirname(placed))), false, "the uploads folder goes with the proxy");
});

test("an older desktop that takes no files says to update Milagre there", async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "forbidden" }));
    request.resume();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-upload-source-"));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(path.join(source, "a.png"), "png");
  await assert.rejects(
    createBrowserAdapter().upload({ host: "127.0.0.1", port: server.address().port, prefix: `/${"a".repeat(48)}` }, path.join(source, "a.png")),
    /older Milagre/,
  );
});

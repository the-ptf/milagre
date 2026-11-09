const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { WebSocketServer, WebSocket } = require("ws");
const { createBrowserPageProxy } = require("./browser-page-proxy.cjs");

async function setup(t) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader("Cache-Control", "public, max-age=31536000");
    res.setHeader("Cloudflare-CDN-Cache-Control", "public, max-age=31536000");
    if (req.url === "/nested/start") {
      res.writeHead(302, { Location: "next" });
      return res.end();
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: `http://127.0.0.1:${upstream.address().port}/next?q=1` });
      return res.end();
    }
    if (req.url === "/cookie") res.setHeader("Set-Cookie", ["session=app; Domain=127.0.0.1; Path=/", "__Host-milagre-browser=forged; Path=/"]);
    req.pipe(res);
    if (req.method === "GET") res.end("page:" + req.url);
  });
  const ws = new WebSocketServer({ server: upstream });
  ws.on("connection", (socket, req) => {
    seen.push({ url: req.url, headers: req.headers });
    socket.on("message", (data) => socket.send(data));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  let stopped = 0;
  const proxy = createBrowserPageProxy({
    tunnel: async ({ port }) => ({
      url: `http://127.0.0.1:${port}`,
      close: async () => {
        stopped++;
      },
    }),
  });
  t.after(async () => {
    await proxy.close();
    ws.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const route = await proxy.open({ url: target + "/start?q=hello#anchor" });
  const login = await fetch(route.url, { redirect: "manual" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  return { proxy, route, target, login, cookie, seen, stopped: () => stopped };
}

test("page proxy authenticates before serving assets and keeps its credential out of upstream requests", async (t) => {
  const { route, login, cookie, seen } = await setup(t);
  assert.equal(login.status, 303);
  const next = await fetch(route.url + "?path=" + encodeURIComponent("/next?q=1#x"), { redirect: "manual" });
  assert.equal(next.headers.get("location"), route.origin + "/next?q=1#x");
  assert.equal((await fetch(route.url + "?path=https://elsewhere.test", { redirect: "manual" })).status, 400);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=None/);
  assert.equal(login.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await fetch(route.origin + "/asset.js")).status, 401);
  assert.equal(seen.length, 0);
  const page = await fetch(route.origin + "/asset.js?q=1", { headers: { Cookie: cookie + "; app=ok" } });
  assert.equal(await page.text(), "page:/asset.js?q=1");
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.equal(page.headers.get("cloudflare-cdn-cache-control"), null);
  assert.equal(seen[0].headers.cookie, "app=ok");
  const posted = await fetch(route.origin + "/api", { method: "POST", body: "payload", headers: { Cookie: cookie, Origin: route.origin } });
  assert.equal(await posted.text(), "payload");
  assert.equal(seen[1].headers.origin, `http://${seen[1].headers.host}`);
});

test("page proxy maps redirects and app cookies to its own origin", async (t) => {
  const { route, cookie } = await setup(t);
  const redirect = await fetch(route.origin + "/redirect", { redirect: "manual", headers: { Cookie: cookie } });
  assert.equal(redirect.headers.get("location"), route.origin + "/next?q=1");
  const relative = await fetch(route.origin + "/nested/start", { redirect: "manual", headers: { Cookie: cookie } });
  assert.equal(relative.headers.get("location"), route.origin + "/nested/next");
  const response = await fetch(route.origin + "/cookie", { headers: { Cookie: cookie } });
  assert.deepEqual(response.headers.getSetCookie(), ["session=app; Path=/"]);
});

test("page proxy carries authenticated WebSockets for HMR and closes them on release", async (t) => {
  const { proxy, route, cookie, stopped } = await setup(t);
  const denied = new WebSocket(route.origin.replace("http:", "ws:") + "/hmr");
  const [failure] = await once(denied, "error");
  assert.match(failure.message, /401/);
  const socket = new WebSocket(route.origin.replace("http:", "ws:") + "/hmr", { headers: { Cookie: cookie }, origin: route.origin });
  await once(socket, "open");
  socket.send("hot update");
  const [reply] = await once(socket, "message");
  assert.equal(reply.toString(), "hot update");
  const closed = once(socket, "close");
  await proxy.release({ id: route.id });
  await closed;
  assert.equal(stopped(), 1);
  await assert.rejects(fetch(route.url));
});

test("page proxy refuses non-web addresses and cleans up tunnel startup failures", async () => {
  const proxy = createBrowserPageProxy({
    tunnel: async () => {
      throw new Error("offline");
    },
  });
  for (const url of ["file:///etc/passwd", "http://user:password@localhost", "not a url"]) await assert.rejects(proxy.open({ url }));
  for (let i = 0; i < 10; i++) await assert.rejects(proxy.open({ url: "http://localhost:3000" }), /offline/);
  await proxy.close();
  await assert.rejects(proxy.open({ url: "http://localhost:3000" }), /closed/);
});

test("a quick tunnel's address is handed out only once public DNS resolves it", async () => {
  const { waitForPublicDns } = require("./browser-page-proxy.cjs");
  let asked = 0;
  const resolver = { resolve4: async () => (++asked < 3 ? Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" })) : ["104.16.0.1"]) };
  assert.equal(await waitForPublicDns("https://fresh-name.trycloudflare.com", { resolver, intervalMs: 1 }), true);
  assert.equal(asked, 3);
  const never = { resolve4: async () => Promise.reject(new Error("not found")) };
  assert.equal(await waitForPublicDns("https://never.trycloudflare.com", { resolver: never, intervalMs: 1, timeoutMs: 5 }), false);
});

test("the page proxy waits for the tunnel to be published before returning it", async () => {
  const order = [];
  const proxy = createBrowserPageProxy({
    tunnel: async () => ({ url: "https://late.trycloudflare.com", close: async () => {} }),
    published: async (url) => {
      order.push(`published ${url}`);
    },
  });
  const lease = await proxy.open({ url: "http://127.0.0.1:9/" });
  order.push("returned");
  assert.deepEqual(order, ["published https://late.trycloudflare.com", "returned"]);
  assert.ok(lease.url.startsWith("https://late.trycloudflare.com/"));
  await proxy.close();
});

test("only loopback, private-range IPs and local names skip certificate checks", () => {
  const { privateTarget } = require("./browser-page-proxy.cjs");
  for (const host of [
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "10.1.2.3",
    "192.168.2.210",
    "172.16.0.1",
    "172.31.255.1",
    "[::1]",
    "fd00::1",
    "fe80::1",
    "santo.local",
    "0.0.0.0",
  ])
    assert.equal(privateTarget(host), true, host);
  for (const host of [
    "localhost.evil.com",
    "127.example.com",
    "10.example.com",
    "192.168.attacker.net",
    "172.16.evil.org",
    "172.32.0.1",
    "8.8.8.8",
    "example.com",
    "local",
    "evil.local.example.com",
  ])
    assert.equal(privateTarget(host), false, host);
});

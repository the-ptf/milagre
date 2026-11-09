const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

function register(handler) {
  const calls = [];
  const middlewares = {
    use(callback) {
      assert.equal(this, middlewares);
      calls.push(callback);
      return this;
    },
  };
  assert.equal(useAsyncMiddleware(middlewares, handler), middlewares);
  assert.equal(calls.length, 1, "register once in the existing middleware stack");
  return calls[0];
}

test("ordinary middleware runs immediately with its arguments and does not fall through on fulfillment", async () => {
  const request = {};
  const response = {};
  const next = assert.fail;
  let invoked = false;
  const middleware = register(async (req, res, callback) => {
    assert.equal(req, request);
    assert.equal(res, response);
    assert.equal(callback, next);
    invoked = true;
  });
  assert.equal(middleware.length, 3, "Connect must recognize an ordinary handler");
  const pending = middleware(request, response, next);
  assert.equal(invoked, true);
  await pending;
});

test("explicit fallthrough calls next exactly once with no arguments", async () => {
  const calls = [];
  await register(async (_request, _response, next) => next())({}, {}, (...args) => calls.push(args));
  assert.deepEqual(calls, [[]]);
});

test("synchronous throws and asynchronous rejections forward the original error exactly once", async () => {
  const error = new Error("HTML transform failed");
  for (const handler of [
    () => {
      throw error;
    },
    async () => {
      await Promise.resolve();
      throw error;
    },
  ]) {
    const calls = [];
    await register(handler)({}, {}, (...args) => calls.push(args));
    assert.deepEqual(calls, [[error]]);
  }
});

test("falsy rejections remain failures instead of becoming Connect fallthrough", async () => {
  for (const reason of [undefined, null, false, 0, ""]) {
    const calls = [];
    await register(() => Promise.reject(reason))({}, {}, (error) => calls.push(error));
    assert.equal(calls.length, 1);
    assert.ok(calls[0] instanceof Error);
    assert.equal(calls[0].cause, reason);
  }
});

test("real Vite requests transform, fall through and return 500 after a rejected transform without stopping the server", { timeout: 15_000 }, async () => {
  const { createServer } = await import("vite");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-async-middleware-"));
  let server;
  try {
    server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, watch: null },
      plugins: [
        {
          name: "async-middleware-regression",
          transformIndexHtml(html, context) {
            if (context.path.startsWith("/reject")) throw new Error("Deliberately rejected HTML transform");
            return html.replace("fixture", "transformed fixture");
          },
          configureServer(vite) {
            useAsyncMiddleware(vite.middlewares, async (request, response, next) => {
              if (!["/success", "/reject-before-set-header", "/reject-after-set-header"].includes(request.url)) return next();
              if (request.url === "/reject-after-set-header") response.setHeader("Content-Type", "text/html");
              const html = await vite.transformIndexHtml(request.url, "<html><body>fixture</body></html>");
              response.setHeader("Content-Type", "text/html");
              response.end(html);
            });
            vite.middlewares.use((request, response, next) => {
              if (request.url !== "/fallthrough") return next();
              response.end("downstream middleware");
            });
          },
        },
      ],
    });
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const get = (route) => fetch(base + route, { signal: AbortSignal.timeout(3_000) });
    const success = await get("/success");
    assert.equal(success.status, 200);
    assert.match(success.headers.get("content-type"), /text\/html/);
    assert.match(await success.text(), /transformed fixture/);
    const fallthrough = await get("/fallthrough");
    assert.equal(fallthrough.status, 200);
    assert.equal(await fallthrough.text(), "downstream middleware");
    for (const route of ["/reject-before-set-header", "/reject-after-set-header"]) {
      const failure = await get(route);
      assert.equal(failure.status, 500, route);
      assert.match(await failure.text(), /Deliberately rejected HTML transform/);
    }
    const recovered = await get("/success");
    assert.equal(recovered.status, 200);
    assert.match(await recovered.text(), /transformed fixture/);
  } finally {
    await server?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

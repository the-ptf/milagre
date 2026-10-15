const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { checkCodex, codexServer, addCodex, removeCodex, readCodexDefinition, signInCodex } = require("./codex.cjs");

test("a Codex status maps to a report", () => {
  assert.deepEqual(
    codexServer(
      { name: "linear", tools: { a: {}, b: {} }, toolsError: null, authStatus: "oAuth", pluginId: null, httpOrigin: "https://mcp.linear.app" },
      { url: "https://mcp.linear.app/mcp" },
    ),
    {
      name: "linear",
      transport: "url",
      scope: "user",
      state: "connected",
      tools: 2,
      error: null,
      detail: "https://mcp.linear.app/mcp",
    },
  );
  assert.deepEqual(
    codexServer(
      { name: "epidemic-sound", tools: {}, toolsError: "MCP startup failed: no key", authStatus: "bearerToken", pluginId: null, httpOrigin: null },
      { url: "https://x" },
    ),
    { name: "epidemic-sound", transport: "url", scope: "user", state: "failed", tools: 0, error: "MCP startup failed: no key", detail: "https://x" },
  );
  assert.equal(codexServer({ name: "m", tools: {}, toolsError: null, authStatus: "notLoggedIn", pluginId: null }, { url: "https://m" }).state, "needs-sign-in");
  assert.equal(
    codexServer({ name: "p", tools: {}, toolsError: null, authStatus: "unsupported", pluginId: null }, { command: "p", enabled: false }).state,
    "disabled",
  );
  assert.equal(codexServer({ name: "pl", tools: {}, toolsError: null, authStatus: "unsupported", pluginId: "x@y" }, undefined).scope, "plugin");
  assert.equal(codexServer({ name: "codex_apps", tools: {}, toolsError: null, authStatus: "bearerToken", pluginId: null }, undefined).scope, "built-in");
  assert.equal(
    codexServer({ name: "argent", tools: { a: {} }, toolsError: null, authStatus: "unsupported", pluginId: null, httpOrigin: null }, { command: "argent" })
      .transport,
    "command",
  );
});

function fakeRpc(pages) {
  const calls = [];
  let page = 0;
  const rpc = {
    calls,
    options: null,
    started: false,
    closed: false,
    start() {
      rpc.started = true;
    },
    notify(method) {
      calls.push(method);
    },
    async request(method, params) {
      calls.push(method);
      if (method === "initialize") return {};
      if (method === "config/read") return { config: { mcp_servers: { linear: { url: "https://mcp.linear.app/mcp" }, argent: { command: "argent" } } } };
      if (method === "mcpServerStatus/list") {
        assert.equal(params.detail, "toolsAndAuthOnly");
        return pages[page++];
      }
      throw new Error("unexpected " + method);
    },
    close() {
      rpc.closed = true;
    },
  };
  return rpc;
}

test("checkCodex reads every page and closes the app-server", async () => {
  const rpc = fakeRpc([
    { data: [{ name: "linear", tools: { a: {} }, toolsError: null, authStatus: "oAuth", pluginId: null }], nextCursor: "2" },
    { data: [{ name: "argent", tools: { a: {}, b: {} }, toolsError: null, authStatus: "unsupported", pluginId: null }], nextCursor: null },
  ]);
  const servers = await checkCodex({
    command: "codex",
    env: { CODEX_HOME: "/x" },
    cwd: "/home",
    createRpc: (options) => {
      rpc.options = options;
      return rpc;
    },
  });
  assert.deepEqual(
    servers.map((s) => `${s.name}:${s.transport}:${s.tools}`),
    ["linear:url:1", "argent:command:2"],
  );
  assert.deepEqual(rpc.calls, ["initialize", "initialized", "config/read", "mcpServerStatus/list", "mcpServerStatus/list"]);
  assert.equal(rpc.options.env.CODEX_HOME, "/x");
  assert.equal(rpc.closed, true);
});

test("aborting the signal closes the app-server while the check hangs", async () => {
  const rpc = fakeRpc([]);
  rpc.request = (method) => (method === "mcpServerStatus/list" ? new Promise(() => {}) : Promise.resolve(method === "config/read" ? { config: {} } : {}));
  const controller = new AbortController();
  void checkCodex({ command: "codex", cwd: "/", signal: controller.signal, createRpc: () => rpc }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rpc.closed, false);
  controller.abort();
  assert.equal(rpc.closed, true);
});

test("a signal that is already aborted closes the app-server right away", async () => {
  const rpc = fakeRpc([]);
  rpc.request = () => new Promise(() => {});
  const controller = new AbortController();
  controller.abort();
  void checkCodex({ command: "codex", cwd: "/", signal: controller.signal, createRpc: () => rpc }).catch(() => {});
  assert.equal(rpc.closed, true);
});

function answerRpc(answers) {
  const requests = [];
  return {
    requests,
    create: () => ({
      start() {},
      notify() {},
      close() {},
      on() {},
      off() {},
      async request(method, params) {
        requests.push({ method, params });
        return answers[method] ?? {};
      },
    }),
  };
}

test("addCodex writes mcp_servers.<name> through the app-server", async () => {
  const rpc = answerRpc({});
  await addCodex({ command: "/bin/codex", cwd: "/", def: { name: "linear", type: "http", url: "https://x", headers: { A: "b" } }, createRpc: rpc.create });
  assert.deepEqual(rpc.requests.at(-1), {
    method: "config/value/write",
    params: { keyPath: "mcp_servers.linear", value: { url: "https://x", http_headers: { A: "b" } }, mergeStrategy: "replace" },
  });
});

test("removeCodex calls codex mcp remove", async () => {
  const calls = [];
  await removeCodex({
    command: "/bin/codex",
    env: {},
    name: "linear",
    run: async (command, args) => (calls.push([command, ...args]), { stdout: "", stderr: "" }),
  });
  assert.deepEqual(calls, [["/bin/codex", "mcp", "remove", "linear"]]);
});

test("readCodexDefinition reads config/read", async () => {
  const rpc = answerRpc({ "config/read": { config: { mcp_servers: { linear: { url: "https://x" } } } } });
  assert.deepEqual(await readCodexDefinition({ command: "/bin/codex", cwd: "/", name: "linear", createRpc: rpc.create }), {
    name: "linear",
    type: "http",
    url: "https://x",
    headers: {},
  });
  assert.equal(await readCodexDefinition({ command: "/bin/codex", cwd: "/", name: "nope", createRpc: rpc.create }), null);
});

test("signInCodex opens the authorization URL and waits for completion", async () => {
  const emitter = new EventEmitter();
  const requests = [];
  const createRpc = () =>
    Object.assign(emitter, {
      start() {},
      notify() {},
      close() {
        emitter.closed = true;
      },
      async request(method, params) {
        requests.push({ method, params });
        if (method === "mcpServer/oauth/login") return { authorizationUrl: "https://auth" };
        return {};
      },
    });
  const opened = [];
  const result = signInCodex({
    command: "/x",
    cwd: "/",
    name: "expo",
    createRpc,
    openUrl: (url) => {
      opened.push(url);
      setImmediate(() => emitter.emit("notification", { method: "mcpServer/oauthLogin/completed", params: { name: "expo", success: true } }));
    },
  });
  assert.deepEqual(await result, { ok: true });
  assert.deepEqual(opened, ["https://auth"]);
  assert.deepEqual(requests.find((r) => r.method === "mcpServer/oauth/login").params, { name: "expo", timeoutSecs: 300 });
  assert.equal(emitter.closed, true);
});

test("signInCodex signs in to an Everywhere server through an ephemeral thread", async () => {
  const emitter = new EventEmitter();
  const requests = [];
  const createRpc = () =>
    Object.assign(emitter, {
      start() {},
      notify() {},
      close() {},
      async request(method, params) {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "t1", ephemeral: true } };
        if (method === "mcpServer/oauth/login") return { authorizationUrl: "u" };
        return {};
      },
    });
  const result = signInCodex({
    command: "/x",
    cwd: "/w",
    name: "linear",
    createRpc,
    everywhere: [{ name: "linear", type: "http", url: "https://x", headers: {} }],
    openUrl: () => setImmediate(() => emitter.emit("notification", { method: "mcpServer/oauthLogin/completed", params: { name: "linear", success: true } })),
  });
  assert.deepEqual(await result, { ok: true });
  assert.deepEqual(requests.find((r) => r.method === "thread/start").params, {
    cwd: "/w",
    config: { mcp_servers: { linear: { url: "https://x" } } },
    ephemeral: true,
  });
  assert.equal(requests.find((r) => r.method === "mcpServer/oauth/login").params.threadId, "t1");
});

test("signInCodex reports a failed completion", async () => {
  const emitter = new EventEmitter();
  const createRpc = () =>
    Object.assign(emitter, {
      start() {},
      notify() {},
      close() {},
      async request(method) {
        return method === "mcpServer/oauth/login" ? { authorizationUrl: "u" } : {};
      },
    });
  const result = signInCodex({
    command: "/x",
    cwd: "/",
    name: "expo",
    createRpc,
    openUrl: () =>
      setImmediate(() => emitter.emit("notification", { method: "mcpServer/oauthLogin/completed", params: { name: "expo", success: false, error: "denied" } })),
  });
  assert.deepEqual(await result, { ok: false, error: "denied" });
});

// A fake app-server whose requests reject once it is closed, like the real CodexRpc.
function signInRpc({ login = { authorizationUrl: "u" }, hangOn } = {}) {
  const emitter = new EventEmitter();
  const state = { closes: 0 };
  let rejectPending = [];
  const rpc = Object.assign(emitter, {
    start() {},
    notify() {},
    close() {
      state.closes += 1;
      state.closed = true;
      for (const reject of rejectPending) reject(new Error("app-server closed"));
      rejectPending = [];
    },
    request(method) {
      if (state.closed) return Promise.reject(new Error("app-server closed"));
      if (method === hangOn) return new Promise((resolve, reject) => rejectPending.push(reject));
      return Promise.resolve(method === "mcpServer/oauth/login" ? login : {});
    },
  });
  return { rpc, state, createRpc: () => rpc };
}
const completed = (name, extra = { success: true }) => ({ method: "mcpServer/oauthLogin/completed", params: { name, ...extra } });

test("signInCodex cancel closes the app-server and leaves no listener", async () => {
  const { rpc, state, createRpc } = signInRpc();
  const controller = new AbortController();
  const result = await signInCodex({ command: "/x", cwd: "/", name: "expo", createRpc, signal: controller.signal, openUrl: () => controller.abort() });
  assert.deepEqual(result, { cancelled: true });
  assert.ok(state.closes >= 1);
  assert.equal(rpc.listenerCount("notification"), 0);
});

test("signInCodex gives up at the cap and leaves no listener", async () => {
  const { rpc, state, createRpc } = signInRpc();
  const result = await signInCodex({ command: "/x", cwd: "/", name: "expo", createRpc, timeoutMs: 20, openUrl() {} });
  assert.deepEqual(result, { ok: false, error: "Sign-in timed out after 5 minutes. Try again." });
  assert.ok(state.closes >= 1);
  assert.equal(rpc.listenerCount("notification"), 0);
});

test("signInCodex ignores a completion for a different server", async () => {
  const { rpc, createRpc } = signInRpc();
  const result = signInCodex({
    command: "/x",
    cwd: "/",
    name: "expo",
    createRpc,
    openUrl: () =>
      setImmediate(() => {
        rpc.emit("notification", completed("other", { success: false, error: "nope" }));
        rpc.emit("notification", completed("expo"));
      }),
  });
  assert.deepEqual(await result, { ok: true });
});

test("signInCodex returns cancelled instead of throwing when aborted before start or during initialize", async () => {
  const before = signInRpc();
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await signInCodex({ command: "/x", cwd: "/", name: "expo", createRpc: before.createRpc, signal: aborted.signal, openUrl() {} }), {
    cancelled: true,
  });
  assert.ok(before.state.closes >= 1);

  const during = signInRpc({ hangOn: "initialize" });
  const controller = new AbortController();
  const pending = signInCodex({ command: "/x", cwd: "/", name: "expo", createRpc: during.createRpc, signal: controller.signal, openUrl() {} });
  setImmediate(() => controller.abort());
  assert.deepEqual(await pending, { cancelled: true });
});

test("signInCodex returns an error instead of throwing when the app-server fails to start", async () => {
  const createRpc = () => ({
    on() {},
    off() {},
    start() {},
    notify() {},
    close() {},
    request: () => Promise.reject(new Error("spawn failed")),
  });
  assert.deepEqual(await signInCodex({ command: "/x", cwd: "/", name: "expo", createRpc, openUrl() {} }), { ok: false, error: "spawn failed" });
});

test("checkCodex reports Everywhere servers through an ephemeral thread", async () => {
  const requests = [];
  const createRpc = () => ({
    start() {},
    notify() {},
    close() {},
    on() {},
    off() {},
    async request(method, params) {
      requests.push({ method, params });
      if (method === "config/read") return { config: { mcp_servers: {} } };
      if (method === "thread/start") return { thread: { id: "t1" } };
      if (method === "mcpServerStatus/list") return params.threadId ? { data: [{ name: "linear", tools: { a: {} }, authStatus: "oAuth" }] } : { data: [] };
      return {};
    },
  });
  const servers = await checkCodex({ command: "/x", cwd: "/w", createRpc, everywhere: [{ name: "linear", type: "http", url: "https://x", headers: {} }] });
  assert.deepEqual(servers, [{ name: "linear", transport: "url", scope: "everywhere", state: "connected", tools: 1, error: null, detail: "https://x" }]);
  assert.equal(requests.find((r) => r.method === "thread/start").params.ephemeral, true);
});

test("codex reports carry detail", () => {
  assert.equal(codexServer({ name: "l", tools: {} }, { url: "https://x" }).detail, "https://x");
  assert.equal(codexServer({ name: "p", tools: {} }, { command: "npx", args: ["y"] }).detail, "npx y");
  assert.equal(codexServer({ name: "q", tools: {} }, undefined).detail, null);
});

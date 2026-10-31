const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUsageReader, readClaudeUsage, readCodexUsage, readAntigravityUsage } = require("./usage.cjs");
const { createUsageStore, cachedSnapshot } = require("./usage-cache.cjs");

const TOKEN = "sk-ant-oat01-SECRET-TOKEN";
const NOW = Date.parse("2026-10-01T19:30:00Z");
const CREDENTIALS = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW + 60 * 60_000, subscriptionType: "max" } });
const CREDENTIALS_FILE = "/Users/test/.claude/.credentials.json";

const USAGE_BODY = {
  five_hour: { utilization: 73, resets_at: "2026-10-01T20:49:59Z" },
  seven_day: { utilization: 61, resets_at: "2026-10-06T19:59:59Z" },
  limits: [
    { kind: "session", group: "session", percent: 73, resets_at: "2026-10-01T20:49:59Z", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 61, resets_at: "2026-10-06T19:59:59Z", scope: null },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 66,
      resets_at: "2026-10-06T19:59:59Z",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
};

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function setup({ platform = "darwin", keychainOutput = CREDENTIALS, fileContents = {}, response = json(200, USAGE_BODY) } = {}) {
  const execCalls = [];
  const fetchCalls = [];
  const deps = {
    platform,
    home: "/Users/test",
    now: () => NOW,
    execFileImpl: (command, args, _options, callback) => {
      execCalls.push({ command, args });
      if (keychainOutput instanceof Error) callback(keychainOutput, "", "");
      else callback(null, keychainOutput, "");
    },
    readFile: async (file) => {
      if (Object.hasOwn(fileContents, file)) return fileContents[file];
      throw Object.assign(new Error(`ENOENT: no such file, open '${file}'`), { code: "ENOENT" });
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { deps, execCalls, fetchCalls };
}

test("reads Claude usage with the Claude Code token and maps every limit", async () => {
  const { deps, execCalls, fetchCalls } = setup();
  const result = await readClaudeUsage(deps);
  assert.deepEqual(execCalls, [{ command: "/usr/bin/security", args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"] }]);
  assert.equal(fetchCalls[0].url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(fetchCalls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(fetchCalls[0].init.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.deepEqual(result, {
    provider: "claude",
    status: "ok",
    updatedAt: new Date(NOW).toISOString(),
    windows: [
      { id: "session", label: "Session", shortLabel: "5h", usedPercent: 73, resetsAt: "2026-10-01T20:49:59Z" },
      { id: "weekly", label: "Weekly", shortLabel: "wk", usedPercent: 61, resetsAt: "2026-10-06T19:59:59Z" },
      { id: "weekly:fable", label: "Fable", shortLabel: "wk", usedPercent: 66, resetsAt: "2026-10-06T19:59:59Z" },
    ],
  });
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test("puts Session and Weekly first and skips limits it does not understand", async () => {
  const [session, weekly, fable] = USAGE_BODY.limits;
  const { deps } = setup({ response: json(200, { limits: [fable, { kind: "monthly_mystery", percent: 10, resets_at: null }, weekly, session] }) });
  const result = await readClaudeUsage(deps);
  assert.deepEqual(
    result.windows.map((item) => item.id),
    ["session", "weekly", "weekly:fable"],
  );
});

test("falls back to five_hour and seven_day when limits is missing", async () => {
  const { deps } = setup({ response: json(200, { five_hour: USAGE_BODY.five_hour, seven_day: USAGE_BODY.seven_day }) });
  const result = await readClaudeUsage(deps);
  assert.deepEqual(
    result.windows.map((item) => [item.id, item.usedPercent]),
    [
      ["session", 73],
      ["weekly", 61],
    ],
  );
});

test("clamps out-of-range percentages and skips missing ones", async () => {
  const { deps } = setup({
    response: json(200, {
      limits: [
        { kind: "session", percent: 130, resets_at: null },
        { kind: "weekly_all", percent: null, resets_at: null },
      ],
    }),
  });
  const result = await readClaudeUsage(deps);
  assert.deepEqual(result.windows, [{ id: "session", label: "Session", shortLabel: "5h", usedPercent: 100, resetsAt: null }]);
});

test("uses the credentials file when the Keychain has no Claude item", async () => {
  const { deps, fetchCalls } = setup({
    keychainOutput: new Error("The specified item could not be found in the keychain."),
    fileContents: { [CREDENTIALS_FILE]: CREDENTIALS },
  });
  const result = await readClaudeUsage(deps);
  assert.equal(result.status, "ok");
  assert.equal(fetchCalls.length, 1);
});

test("skips the Keychain outside macOS", async () => {
  const { deps, execCalls } = setup({ platform: "linux", fileContents: { [CREDENTIALS_FILE]: CREDENTIALS } });
  const result = await readClaudeUsage(deps);
  assert.equal(result.status, "ok");
  assert.equal(execCalls.length, 0);
});

test("reports unavailable without calling the API when there are no credentials", async () => {
  const { deps, fetchCalls } = setup({ keychainOutput: new Error("not found") });
  const result = await readClaudeUsage(deps);
  assert.deepEqual([result.status, result.windows, result.message], ["unavailable", [], "Not signed in to Claude Code."]);
  assert.equal(fetchCalls.length, 0);
});

test("ignores malformed credentials without echoing them", async () => {
  const { deps } = setup({ keychainOutput: `{"claudeAiOauth":{"accessToken":"${TOKEN}"` });
  const result = await readClaudeUsage(deps);
  assert.equal(result.status, "unavailable");
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test("reports an expired sign-in without calling the API", async () => {
  const { deps, fetchCalls } = setup({ keychainOutput: JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW - 1 } }) });
  const result = await readClaudeUsage(deps);
  assert.deepEqual([result.status, result.message], ["error", "Claude sign-in expired. Running any Claude agent refreshes it."]);
  assert.equal(fetchCalls.length, 0);
});

const FAILURES = [
  ["HTTP 401", json(401, { error: "unauthorized" }), "Claude sign-in expired. Running any Claude agent refreshes it."],
  ["HTTP 429", json(429, {}), "Claude is rate limiting usage checks."],
  ["HTTP 500", json(500, {}), "Claude usage failed (HTTP 500)."],
  [
    "unreadable JSON",
    {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError(`Unexpected token near ${TOKEN}`);
      },
    },
    "Claude returned an unreadable usage response.",
  ],
  ["no windows", json(200, { limits: [] }), "Claude returned no usage windows."],
  ["a network failure", new TypeError(`fetch failed for ${TOKEN}`), "Couldn't reach Claude."],
  ["a timeout", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), "Claude usage timed out."],
];

for (const [name, response, message] of FAILURES) {
  test(`reports ${name} as an error without leaking the token`, async () => {
    const { deps } = setup({ response });
    const result = await readClaudeUsage(deps);
    assert.deepEqual([result.status, result.windows, result.message], ["error", [], message]);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
}

const RESETS_AT = 1791070247;
const WEEKLY_ONLY = { primary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: RESETS_AT }, secondary: null };

function fakeCodex({ account = { type: "chatgpt", planType: "pro" }, rateLimits, resetCredits, chunked = false, reply = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.sent = [];
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  const emit = (message) => {
    const text = `${JSON.stringify(message)}\n`;
    if (!chunked) {
      setImmediate(() => child.stdout.emit("data", Buffer.from(text)));
      return;
    }
    const middle = Math.floor(text.length / 2);
    const notification = `${JSON.stringify({ method: "account/updated", params: { authMode: "chatgpt" } })}\n`;
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(notification + text.slice(0, middle)));
      setImmediate(() => child.stdout.emit("data", Buffer.from(text.slice(middle))));
    });
  };
  child.stdin.write = (text) => {
    for (const line of String(text).split("\n").filter(Boolean)) {
      const message = JSON.parse(line);
      child.sent.push(message.method);
      if (!reply || message.id === undefined) continue;
      if (message.method === "initialize") emit({ id: message.id, result: { userAgent: "codex" } });
      if (message.method === "account/read") emit({ id: message.id, result: { account, requiresOpenaiAuth: true } });
      if (message.method === "account/rateLimits/read")
        emit({ id: message.id, result: { rateLimits, ...(resetCredits ? { rateLimitResetCredits: resetCredits } : {}) } });
    }
    return true;
  };
  return child;
}

function codexDeps(child, overrides = {}) {
  const spawnCalls = [];
  const deps = {
    now: () => NOW,
    timeoutMs: 200,
    command: "codex",
    spawnImpl: (command, args) => {
      spawnCalls.push({ command, args });
      return child;
    },
    ...overrides,
  };
  return { deps, spawnCalls };
}

test("reads Codex usage from the app server and stops it", async () => {
  const child = fakeCodex({ rateLimits: WEEKLY_ONLY });
  const { deps, spawnCalls } = codexDeps(child);
  const result = await readCodexUsage(deps);
  assert.deepEqual(spawnCalls, [{ command: "codex", args: ["app-server"] }]);
  assert.deepEqual(child.sent, ["initialize", "initialized", "account/read", "account/rateLimits/read"]);
  assert.deepEqual(result, {
    provider: "codex",
    status: "ok",
    updatedAt: new Date(NOW).toISOString(),
    windows: [{ id: "weekly", label: "Weekly", shortLabel: "wk", usedPercent: 88, resetsAt: new Date(RESETS_AT * 1000).toISOString() }],
  });
  assert.equal(child.killed, true);
});

test("reports banked Codex resets only when there are some", async () => {
  const banked = await readCodexUsage(codexDeps(fakeCodex({ rateLimits: WEEKLY_ONLY, resetCredits: { availableCount: 3, credits: [] } })).deps);
  assert.equal(banked.bankedResets, 3);
  const none = await readCodexUsage(codexDeps(fakeCodex({ rateLimits: WEEKLY_ONLY, resetCredits: { availableCount: 0, credits: [] } })).deps);
  assert.equal("bankedResets" in none, false);
});

test("orders Codex windows shortest first and labels other durations", async () => {
  const both = fakeCodex({
    rateLimits: {
      primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: RESETS_AT },
      secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
    },
  });
  const result = await readCodexUsage(codexDeps(both).deps);
  assert.deepEqual(
    result.windows.map((item) => [item.id, item.label, item.shortLabel]),
    [
      ["session", "Session", "5h"],
      ["weekly", "Weekly", "wk"],
    ],
  );

  const odd = fakeCodex({
    rateLimits: {
      primary: { usedPercent: 5, windowDurationMins: 1440, resetsAt: null },
      secondary: { usedPercent: 6, windowDurationMins: 90, resetsAt: null },
    },
  });
  const oddResult = await readCodexUsage(codexDeps(odd).deps);
  assert.deepEqual(
    oddResult.windows.map((item) => [item.id, item.label, item.shortLabel]),
    [
      ["window:90", "90m window", "90m"],
      ["window:1440", "1d window", "1d"],
    ],
  );
});

test("parses replies split across chunks and mixed with notifications", async () => {
  const child = fakeCodex({ rateLimits: WEEKLY_ONLY, chunked: true });
  const result = await readCodexUsage(codexDeps(child).deps);
  assert.equal(result.status, "ok");
  assert.equal(result.windows[0].usedPercent, 88);
});

test("reports unavailable when Codex is not signed in", async () => {
  const child = fakeCodex({ account: null, rateLimits: WEEKLY_ONLY });
  const result = await readCodexUsage(codexDeps(child).deps);
  assert.deepEqual([result.status, result.message], ["unavailable", "Not signed in to Codex."]);
  assert.ok(!child.sent.includes("account/rateLimits/read"));
  assert.equal(child.killed, true);
});

test("reports unavailable when the Codex CLI is not installed", async () => {
  const child = fakeCodex({ reply: false });
  setImmediate(() => child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })));
  const result = await readCodexUsage(codexDeps(child).deps);
  assert.deepEqual([result.status, result.message], ["unavailable", "Codex CLI not found."]);
});

test("times out, kills Codex and reports an error", async () => {
  const child = fakeCodex({ reply: false });
  const result = await readCodexUsage(codexDeps(child, { timeoutMs: 20 }).deps);
  assert.deepEqual([result.status, result.message], ["error", "Codex usage timed out."]);
  assert.equal(child.killed, true);
});

test("reports an error when Codex exits early or returns no windows", async () => {
  const exited = fakeCodex({ reply: false });
  setImmediate(() => exited.emit("close", 1, null));
  const early = await readCodexUsage(codexDeps(exited).deps);
  assert.deepEqual([early.status, early.message], ["error", "Codex exited before reporting usage."]);

  const empty = fakeCodex({ rateLimits: { primary: null, secondary: null } });
  const none = await readCodexUsage(codexDeps(empty).deps);
  assert.deepEqual([none.status, none.message], ["error", "Codex returned no usage windows."]);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("shares one in-flight read between concurrent callers", async () => {
  let claudeReads = 0;
  let codexReads = 0;
  const claude = deferred();
  const updatedAt = new Date(NOW).toISOString();
  const readUsage = createUsageReader({
    now: () => NOW,
    readClaude: () => {
      claudeReads += 1;
      return claude.promise;
    },
    readCodex: async () => {
      codexReads += 1;
      return { provider: "codex", status: "unavailable", windows: [], updatedAt, message: "Codex CLI not found." };
    },
  });

  const first = readUsage();
  const second = readUsage();
  assert.equal(first, second);
  claude.resolve({ provider: "claude", status: "ok", windows: [], updatedAt });
  const snapshot = await first;
  assert.deepEqual(
    snapshot.providers.map((item) => item.provider),
    ["claude", "codex", "antigravity", "kiro"],
  );
  // Kiro's credits aren't read yet: its row is unavailable and the sidebar leaves it out.
  assert.equal(snapshot.providers.at(-1).status, "unavailable");
  assert.deepEqual([claudeReads, codexReads], [1, 1]);

  await readUsage();
  assert.deepEqual([claudeReads, codexReads], [2, 2]);
});

test("waits for the login environment before reading either provider", async () => {
  const updatedAt = new Date(NOW).toISOString();
  const environment = deferred();
  const order = [];
  const readUsage = createUsageReader({
    now: () => NOW,
    ready: () => environment.promise.then(() => order.push("environment")),
    readClaude: async () => {
      order.push("claude");
      return { provider: "claude", status: "ok", windows: [], updatedAt };
    },
    readCodex: async () => {
      order.push("codex");
      return { provider: "codex", status: "ok", windows: [], updatedAt };
    },
  });
  const pending = readUsage();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  environment.resolve();
  await pending;
  assert.deepEqual(order, ["environment", "claude", "codex"]);
});

test("turns a reader crash into an error for that provider only", async () => {
  const updatedAt = new Date(NOW).toISOString();
  const readUsage = createUsageReader({
    now: () => NOW,
    readClaude: () => {
      throw new Error(`boom ${TOKEN}`);
    },
    readCodex: async () => ({ provider: "codex", status: "ok", windows: [], updatedAt }),
  });
  const { providers } = await readUsage();
  assert.deepEqual(providers[0], { provider: "claude", status: "error", windows: [], updatedAt, message: "Couldn't read usage." });
  assert.equal(providers[1].status, "ok");
  assert.ok(!JSON.stringify(providers).includes(TOKEN));
});

test("reports unavailable for Codex accounts without ChatGPT plan limits", async () => {
  for (const type of ["apiKey", "amazonBedrock"]) {
    const child = fakeCodex({ account: { type }, rateLimits: WEEKLY_ONLY });
    const result = await readCodexUsage(codexDeps(child).deps);
    assert.deepEqual([result.status, result.message], ["unavailable", "Codex plan limits need a ChatGPT sign-in."]);
    assert.ok(!child.sent.includes("account/rateLimits/read"));
  }
});

// Backoff and last-good fallback.
const RATE_LIMIT_MESSAGE = "Claude is rate limiting usage checks.";
const MIN = 60_000;

function rateLimited(retryAfter) {
  return { ...json(429, {}), headers: { get: (name) => (name.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) } };
}

test("a 429 reports Retry-After seconds as retryAfterMs", async () => {
  const result = await readClaudeUsage(setup({ response: rateLimited("120") }).deps);
  assert.deepEqual([result.status, result.windows, result.message, result.retryAfterMs], ["error", [], RATE_LIMIT_MESSAGE, 120_000]);
});

test("a 429 defaults to 5 minutes and caps at 30", async () => {
  for (const [header, expected] of [
    [undefined, 5 * MIN],
    ["soon", 5 * MIN],
    ["-3", 5 * MIN],
    ["999999", 30 * MIN],
  ]) {
    const result = await readClaudeUsage(setup({ response: rateLimited(header) }).deps);
    assert.equal(result.retryAfterMs, expected, String(header));
  }
  // A response without any headers object still works.
  assert.equal((await readClaudeUsage(setup({ response: json(429, {}) }).deps)).retryAfterMs, 5 * MIN);
});

test("a 429 parses an HTTP-date Retry-After", async () => {
  const result = await readClaudeUsage(setup({ response: rateLimited(new Date(NOW + 90_000).toUTCString()) }).deps);
  assert.equal(result.retryAfterMs, 90_000);
  const past = await readClaudeUsage(setup({ response: rateLimited(new Date(NOW - 90_000).toUTCString()) }).deps);
  assert.equal(past.retryAfterMs, 5 * MIN);
});

function claudeReader({ responses, store = createUsageStore(), clock }) {
  const queue = [...responses];
  const fetchCalls = [];
  const { deps } = setup();
  const time = clock ?? { now: NOW };
  const now = () => time.now;
  const readUsage = createUsageReader({
    now,
    store,
    readClaude: () =>
      readClaudeUsage({
        ...deps,
        now,
        fetchImpl: async (url) => {
          fetchCalls.push(url);
          return queue.shift();
        },
      }),
    readCodex: async () => ({
      provider: "codex",
      status: "unavailable",
      windows: [],
      updatedAt: new Date(now()).toISOString(),
      message: "Codex CLI not found.",
    }),
  });
  return { readUsage, fetchCalls, time };
}
const claudeOf = (snapshot) => snapshot.providers.find((item) => item.provider === "claude");

test("while blocked by a 429 the API is not called, and it is called again afterwards", async () => {
  const { readUsage, fetchCalls, time } = claudeReader({ responses: [rateLimited("120"), json(200, USAGE_BODY)] });
  assert.equal(claudeOf(await readUsage()).status, "error");
  time.now = NOW + 119_000;
  const blocked = claudeOf(await readUsage());
  assert.deepEqual([blocked.status, blocked.message, fetchCalls.length], ["error", RATE_LIMIT_MESSAGE, 1]);
  time.now = NOW + 120_000;
  assert.equal(claudeOf(await readUsage()).status, "ok");
  assert.equal(fetchCalls.length, 2);
});

test("after an ok read, a 429 returns the earlier windows with the original updatedAt", async () => {
  const { readUsage, time } = claudeReader({ responses: [json(200, USAGE_BODY), rateLimited("60")] });
  const good = claudeOf(await readUsage());
  time.now = NOW + 10 * MIN;
  const limited = claudeOf(await readUsage());
  assert.equal(limited.status, "error");
  assert.equal(limited.message, RATE_LIMIT_MESSAGE);
  assert.equal(limited.updatedAt, good.updatedAt);
  assert.deepEqual(limited.windows, good.windows);
  // Still served from the cache while blocked.
  time.now += 30_000;
  assert.deepEqual(claudeOf(await readUsage()).windows, good.windows);
});

test("a fresh reader falls back to a persisted ok result after a 429", async () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "usage-cache-"));
  const file = path.join(dir, "usage-cache.json");
  try {
    const writer = createUsageStore({ file });
    const first = claudeReader({ responses: [json(200, USAGE_BODY)], store: writer });
    const good = claudeOf(await first.readUsage());
    await writer.idle();
    const second = claudeReader({ responses: [rateLimited("60")], store: createUsageStore({ file }), clock: { now: NOW + 5 * MIN } });
    const limited = claudeOf(await second.readUsage());
    assert.deepEqual([limited.status, limited.updatedAt, limited.windows], ["error", good.updatedAt, good.windows]);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("a persisted block survives a restart", async () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "usage-cache-"));
  const file = path.join(dir, "usage-cache.json");
  try {
    const writer = createUsageStore({ file });
    const first = claudeReader({ responses: [json(200, USAGE_BODY), rateLimited("600")], store: writer });
    await first.readUsage();
    first.time.now = NOW + MIN;
    await first.readUsage();
    await writer.idle();
    const second = claudeReader({ responses: [], store: createUsageStore({ file }), clock: { now: NOW + 2 * MIN } });
    const result = claudeOf(await second.readUsage());
    assert.deepEqual([result.status, second.fetchCalls.length, result.windows.length], ["error", 0, 3]);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("fallback drops windows whose reset time has passed", async () => {
  const { readUsage, time } = claudeReader({ responses: [json(200, USAGE_BODY), rateLimited("60")] });
  await readUsage();
  time.now = Date.parse("2026-10-01T21:00:00Z");
  const limited = claudeOf(await readUsage());
  assert.deepEqual(
    limited.windows.map((item) => item.id),
    ["weekly", "weekly:fable"],
  );
});

test("with no last good result a 429 is returned as is", async () => {
  const { readUsage } = claudeReader({ responses: [rateLimited("60")] });
  const result = claudeOf(await readUsage());
  assert.deepEqual([result.status, result.windows, result.message], ["error", [], RATE_LIMIT_MESSAGE]);
});

test("a corrupt or missing cache file starts empty without throwing", async () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "usage-cache-"));
  try {
    for (const contents of ["{not json", "[]", JSON.stringify({ claude: { last: { windows: "nope" }, blocked: { until: "x" } } })]) {
      const file = path.join(dir, "usage-cache.json");
      fsSync.writeFileSync(file, contents);
      const store = createUsageStore({ file });
      assert.equal(store.get("claude").last, null);
      assert.equal(store.get("claude").blocked, null);
    }
    const store = createUsageStore({ file: path.join(dir, "missing.json") });
    assert.equal(store.get("codex").last, null);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("the persisted cache contains no credentials", async () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "usage-cache-"));
  const file = path.join(dir, "usage-cache.json");
  try {
    const store = createUsageStore({ file });
    const { readUsage } = claudeReader({ responses: [json(200, USAGE_BODY)], store });
    await readUsage();
    await store.idle();
    const written = fsSync.readFileSync(file, "utf8");
    assert.ok(written.includes('"windows"'));
    assert.ok(!written.includes(TOKEN));
    assert.ok(!written.includes("accessToken"));
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("cachedSnapshot builds ok providers from the store and drops expired windows", async () => {
  const store = createUsageStore();
  store.setLast("claude", {
    windows: [
      { id: "session", label: "Session", shortLabel: "5h", usedPercent: 73, resetsAt: "2026-10-01T20:49:59Z" },
      { id: "weekly", label: "Weekly", shortLabel: "wk", usedPercent: 61, resetsAt: "2026-10-06T19:59:59Z" },
    ],
    updatedAt: "2026-10-01T19:00:00.000Z",
  });
  store.setLast("codex", {
    windows: [{ id: "weekly", label: "Weekly", shortLabel: "wk", usedPercent: 88, resetsAt: "2026-10-01T20:00:00Z" }],
    updatedAt: "2026-10-01T19:10:00.000Z",
  });
  const snapshot = cachedSnapshot(store, Date.parse("2026-10-01T21:00:00Z"));
  assert.deepEqual(snapshot, {
    providers: [
      {
        provider: "claude",
        status: "ok",
        windows: [{ id: "weekly", label: "Weekly", shortLabel: "wk", usedPercent: 61, resetsAt: "2026-10-06T19:59:59Z" }],
        updatedAt: "2026-10-01T19:00:00.000Z",
      },
    ],
  });
  assert.deepEqual(cachedSnapshot(createUsageStore(), NOW), { providers: [] });
});

test("the store keeps a banked reset count and drops zero or junk", () => {
  const store = createUsageStore();
  const windows = [{ id: "weekly", label: "Weekly", shortLabel: "wk", usedPercent: 88, resetsAt: null }];
  store.setLast("codex", { windows, updatedAt: "2026-10-01T19:10:00.000Z", bankedResets: 2 });
  assert.equal(cachedSnapshot(store, NOW).providers[0].bankedResets, 2);
  store.setLast("codex", { windows, updatedAt: "2026-10-01T19:10:00.000Z", bankedResets: "lots" });
  assert.equal("bankedResets" in cachedSnapshot(store, NOW).providers[0], false);
});

test("Antigravity usage goes through the reader, is cached as numbers and keeps the last good ones on an error", async () => {
  const updatedAt = new Date(NOW).toISOString();
  const windows = [{ id: "gemini:weekly", label: "Gemini weekly", shortLabel: "wk", usedPercent: 25, resetsAt: "2026-10-15T00:00:00Z" }];
  const results = [
    { provider: "antigravity", status: "ok", windows, updatedAt },
    { provider: "antigravity", status: "error", windows: [], updatedAt, message: "Antigravity usage timed out." },
  ];
  const store = createUsageStore();
  const readUsage = createUsageReader({
    now: () => NOW,
    store,
    readClaude: async () => ({ provider: "claude", status: "ok", windows: [], updatedAt }),
    readCodex: async () => ({ provider: "codex", status: "ok", windows: [], updatedAt }),
    readAntigravity: async () => results.shift(),
  });
  const find = (snapshot) => snapshot.providers.find((item) => item.provider === "antigravity");
  assert.deepEqual(find(await readUsage()).windows, windows);
  assert.deepEqual(cachedSnapshot(store, NOW).providers.find((item) => item.provider === "antigravity").windows, windows);
  const failed = find(await readUsage());
  assert.equal(failed.status, "error");
  assert.deepEqual(failed.windows, windows);
});

test("without a signed-in profile the default Antigravity reader is unavailable", async () => {
  const antigravity = await readAntigravityUsage({ now: () => NOW });
  assert.equal(antigravity.status, "unavailable");
  assert.deepEqual(antigravity.windows, []);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readAntigravityUsage } = require("./antigravity-usage.cjs");

const NOW = Date.parse("2026-10-08T12:00:00Z");
const SECRETS = ["client-secret-VALUE", "refresh-token-VALUE", "access-token-VALUE", "client-id-VALUE"];

function profile(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-usage-"));
  fs.mkdirSync(path.join(home, "antigravity-acp"));
  const file = path.join(home, "antigravity-acp", "acp_token.json");
  const credentials = {
    client_id: "client-id-VALUE",
    client_secret: "client-secret-VALUE",
    refresh_token: "refresh-token-VALUE",
    token_uri: "https://oauth2.googleapis.com/token",
    scopes: ["a"],
    project_id: "aicode-consumers",
    ...overrides,
  };
  fs.writeFileSync(file, JSON.stringify(credentials));
  return { home, file, write: (next) => fs.writeFileSync(file, JSON.stringify({ ...credentials, ...next })) };
}

const QUOTA = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.75, resetTime: "2026-10-15T00:00:00Z" },
        { bucketId: "gemini-5h", window: "5h", remainingFraction: 1, resetTime: "2026-10-08T17:00:00Z" },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.1, resetTime: "2026-10-15T00:00:00Z" },
        { bucketId: "3p-5h", window: "5h", remainingFraction: 0.2, resetTime: "2026-10-08T17:00:00Z" },
      ],
    },
  ],
};

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A fake Google: `quota` is called per quota request with the bearer token it carried. */
function google({
  quota = () => response(200, QUOTA),
  refresh = (n) => response(200, { access_token: `access-token-VALUE-${n}`, expires_in: 3599, token_type: "Bearer" }),
} = {}) {
  const calls = [];
  let refreshes = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("oauth2.googleapis.com")) return refresh(++refreshes);
    if (url.endsWith(":retrieveUserQuotaSummary")) return quota(init.headers.Authorization, init);
    if (url.endsWith(":loadCodeAssist")) return response(200, { cloudaicompanionProject: "discovered-project" });
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, calls, refreshes: () => refreshes, quotaCalls: () => calls.filter((call) => call.url.endsWith(":retrieveUserQuotaSummary")) };
}

const read = (home, fake, extra = {}) =>
  readAntigravityUsage({ env: { GEMINI_HOME: home }, fetch: fake.fetch, now: () => NOW, tokens: new Map(), platform: "darwin", arch: "arm64", ...extra });

test("refreshes the token, asks for the Gemini quota and maps it to windows", async () => {
  const { home } = profile();
  const fake = google();
  const result = await read(home, fake);
  assert.deepEqual(result, {
    provider: "antigravity",
    status: "ok",
    updatedAt: new Date(NOW).toISOString(),
    windows: [
      { id: "gemini:5h", label: "Gemini 5-hour", shortLabel: "5h", usedPercent: 0, resetsAt: "2026-10-08T17:00:00Z" },
      { id: "gemini:weekly", label: "Gemini weekly", shortLabel: "wk", usedPercent: 25, resetsAt: "2026-10-15T00:00:00Z" },
    ],
  });
  const [refresh, quota] = fake.calls;
  assert.equal(refresh.url, "https://oauth2.googleapis.com/token");
  assert.equal(refresh.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(refresh.init.body);
  assert.deepEqual(Object.fromEntries(form), {
    client_id: "client-id-VALUE",
    client_secret: "client-secret-VALUE",
    refresh_token: "refresh-token-VALUE",
    grant_type: "refresh_token",
  });
  assert.equal(quota.url, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
  assert.equal(quota.init.headers.Authorization, "Bearer access-token-VALUE-1");
  assert.equal(quota.init.headers["User-Agent"], "antigravity/hub/2.9.1 darwin/arm64");
  assert.deepEqual(JSON.parse(quota.init.body), { project: "aicode-consumers" });
});

test("never writes the token file", async () => {
  const { home, file } = profile();
  const before = fs.readFileSync(file, "utf8");
  const mtime = fs.statSync(file).mtimeMs;
  await read(home, google());
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test("caches the access token across calls until five minutes before it expires", async () => {
  const { home } = profile();
  const fake = google();
  const tokens = new Map();
  let clock = NOW;
  const again = () => readAntigravityUsage({ env: { GEMINI_HOME: home }, fetch: fake.fetch, now: () => clock, tokens });
  await again();
  clock += 30 * 60_000;
  await again();
  assert.equal(fake.refreshes(), 1);
  assert.equal(fake.quotaCalls().length, 2);
  clock = NOW + 3599_000 - 4 * 60_000;
  await again();
  assert.equal(fake.refreshes(), 2, "within five minutes of expiry the token is refreshed");
  assert.equal(fake.quotaCalls().at(-1).init.headers.Authorization, "Bearer access-token-VALUE-2");
});

test("keeps profiles apart", async () => {
  const one = profile();
  const two = profile();
  const fake = google();
  const tokens = new Map();
  await read(one.home, fake, { tokens });
  await read(two.home, fake, { tokens });
  assert.equal(fake.refreshes(), 2);
});

test("a 401 re-reads the token file, refreshes once and retries", async () => {
  const { home, write } = profile();
  const seen = [];
  const fake = google({
    quota: (authorization) => {
      seen.push(authorization);
      return authorization.endsWith("-1") ? response(401, {}) : response(200, QUOTA);
    },
  });
  const tokens = new Map();
  const result = await read(home, fake, { tokens });
  assert.equal(result.status, "ok");
  assert.deepEqual(seen, ["Bearer access-token-VALUE-1", "Bearer access-token-VALUE-2"]);
  // The agent rewrote its token file; the next refresh sends the new refresh token.
  write({ refresh_token: "rotated-refresh-token" });
  tokens.clear();
  await read(home, fake, { tokens });
  const form = new URLSearchParams(fake.calls.findLast((call) => call.url.includes("oauth2")).init.body);
  assert.equal(form.get("refresh_token"), "rotated-refresh-token");
});

test("a second 401 reports an expired sign-in and drops the cached token", async () => {
  const { home } = profile();
  const fake = google({ quota: () => response(401, {}) });
  const tokens = new Map();
  const result = await read(home, fake, { tokens });
  assert.equal(result.status, "error");
  assert.equal(result.message, "Antigravity sign-in expired. Sign in again from Settings.");
  assert.equal(fake.refreshes(), 2);
  assert.equal(tokens.size, 0);
});

test("a revoked refresh token (invalid_grant) is an expired sign-in", async () => {
  const { home } = profile();
  const fake = google({ refresh: () => response(400, { error: "invalid_grant", error_description: "refresh-token-VALUE" }) });
  const result = await read(home, fake);
  assert.equal(result.status, "error");
  assert.equal(result.message, "Antigravity sign-in expired. Sign in again from Settings.");
  assert.equal(fake.quotaCalls().length, 0);
});

test("a missing, empty or unreadable token file is unavailable", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "agy-usage-"));
  const missing = await read(empty, google());
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.message, "Not signed in to Antigravity.");
  assert.equal((await readAntigravityUsage({ env: {}, fetch: google().fetch, now: () => NOW })).status, "unavailable");

  const broken = profile();
  fs.writeFileSync(broken.file, '{"refresh_token": "refresh-token-VALUE", oops');
  const unreadable = await read(broken.home, google());
  assert.equal(unreadable.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(unreadable), /refresh-token-VALUE/);
});

test("a disabled bucket or one without remainingFraction has no window, rather than 100 percent", async () => {
  const { home } = profile();
  const quota = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-5h", window: "5h", disabled: true, remainingFraction: 1, resetTime: "2026-10-08T17:00:00Z" },
          { bucketId: "gemini-weekly", window: "weekly", resetTime: "2026-10-15T00:00:00Z" },
        ],
      },
    ],
  };
  const result = await read(home, google({ quota: () => response(200, quota) }));
  assert.equal(result.status, "error");
  assert.deepEqual(result.windows, []);
  const one = { groups: [{ displayName: "Gemini Models", buckets: [{ ...quota.groups[0].buckets[0], disabled: false }, quota.groups[0].buckets[1]] }] };
  assert.deepEqual(
    (await read(home, google({ quota: () => response(200, one) }))).windows.map((item) => item.id),
    ["gemini:5h"],
  );
});

test("a weekly-only account shows only the weekly window", async () => {
  const { home } = profile();
  const quota = {
    groups: [
      { displayName: "Gemini Models", buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5, resetTime: "2026-10-15T00:00:00Z" }] },
    ],
  };
  const result = await read(home, google({ quota: () => response(200, quota) }));
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.windows.map((item) => [item.id, item.usedPercent]),
    [["gemini:weekly", 50]],
  );
});

test("groups other than Gemini are ignored", async () => {
  const { home } = profile();
  const quota = { groups: [QUOTA.groups[1]] };
  const result = await read(home, google({ quota: () => response(200, quota) }));
  assert.equal(result.status, "error");
  assert.equal(result.message, "Google returned no Gemini usage windows.");
});

test("clamps fractions and tolerates a missing or invalid reset time", async () => {
  const { home } = profile();
  const quota = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 1.2, resetTime: "soon" },
          { bucketId: "gemini-weekly", window: "weekly", remainingFraction: -0.5 },
        ],
      },
    ],
  };
  const result = await read(home, google({ quota: () => response(200, quota) }));
  assert.deepEqual(
    result.windows.map((item) => [item.usedPercent, item.resetsAt]),
    [
      [0, null],
      [100, null],
    ],
  );
});

test("without a project_id it asks loadCodeAssist for the project", async () => {
  const { home } = profile({ project_id: undefined });
  const fake = google();
  const result = await read(home, fake);
  assert.equal(result.status, "ok");
  const load = fake.calls.find((call) => call.url.endsWith(":loadCodeAssist"));
  assert.deepEqual(JSON.parse(load.init.body), { metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } });
  assert.deepEqual(JSON.parse(fake.quotaCalls()[0].init.body), { project: "discovered-project" });
});

test("a token_uri outside Google is not trusted with the client secret", async () => {
  const { home } = profile({ token_uri: "https://evil.example/token" });
  const fake = google();
  await read(home, fake);
  assert.equal(fake.calls[0].url, "https://oauth2.googleapis.com/token");
});

test("failures become short messages that carry no secrets", async () => {
  const { home } = profile();
  const cases = [
    [google({ quota: () => response(500, { error: "access-token-VALUE-1 client-secret-VALUE" }) }), "Antigravity usage failed (HTTP 500)."],
    [
      google({
        quota: () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token refresh-token-VALUE");
          },
        }),
      }),
      "Google returned no Gemini usage windows.",
    ],
    [google({ refresh: () => response(503, {}) }), "Antigravity sign-in refresh failed (HTTP 503)."],
    [google({ refresh: () => response(200, { token_type: "Bearer" }) }), "Google returned an unreadable sign-in response."],
  ];
  for (const [fake, message] of cases) {
    const result = await read(home, fake);
    assert.equal(result.status, "error");
    assert.equal(result.message, message);
    for (const secret of SECRETS) assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
  const network = await readAntigravityUsage({
    env: { GEMINI_HOME: home },
    fetch: async () => {
      throw new TypeError("connect failed for client-secret-VALUE");
    },
    now: () => NOW,
    tokens: new Map(),
  });
  assert.equal(network.message, "Couldn't reach Google.");
  const timeout = await readAntigravityUsage({
    env: { GEMINI_HOME: home },
    fetch: async () => {
      throw Object.assign(new Error("x"), { name: "TimeoutError" });
    },
    now: () => NOW,
    tokens: new Map(),
  });
  assert.equal(timeout.message, "Antigravity usage timed out.");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspectAntigravityAccount, prepareAntigravityProfile, signInAntigravity, validSignInUrl } = require("./antigravity-account.cjs");

const FAKE = path.join(__dirname, "agents", "fixtures", "fake-agy-sign-in.cjs");

function fixture(t, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-antigravity-account-"));
  const home = path.join(root, "profile");
  fs.mkdirSync(home, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GEMINI_HOME: home, GEMINI_API_KEY: "ambient-secret", ...extraEnv };
  const start = (options = {}) =>
    signInAntigravity({ command: process.execPath, args: [FAKE], harness: path.join(root, "harness"), env, tempRoot: path.join(root, "tmp"), ...options });
  const recorded = () => JSON.parse(fs.readFileSync(path.join(home, "fake-agy-env.json"), "utf8"));
  return { root, home, env, start, recorded };
}

test("sign-in opens Google's link once, finishes after the browser callback and cleans up", async (t) => {
  const f = fixture(t);
  const opened = [];
  const flow = f.start({
    openUrl: (url) => {
      opened.push(url);
      // The browser: Google redirects to the agent's loopback port.
      void fetch(`${new URL(url).searchParams.get("redirect_uri")}?code=fake`);
    },
  });
  await flow.done;
  assert.equal(opened.length, 1);
  assert.ok(validSignInUrl(opened[0]));
  assert.deepEqual(inspectAntigravityAccount({ env: f.env }), { state: "ready", email: "person@example.test" });
  assert.doesNotMatch(JSON.stringify(inspectAntigravityAccount({ env: f.env })), /secret/);
  const env = f.recorded();
  assert.equal(env.GEMINI_API_KEY, undefined, "Ambient credentials are scrubbed");
  assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, "1");
  // BROWSER is split on the path separator, a semicolon on Windows, where a .cmd is what runs.
  if (process.platform === "win32") assert.match(env.BROWSER, /^[^;]+\.cmd$/);
  else {
    assert.ok(fs.statSync(env.BROWSER).mode & 0o100, "BROWSER is an executable helper");
    assert.doesNotMatch(env.BROWSER, /[:;]/);
  }
  assert.equal(fs.existsSync(env.TMPDIR), false, "The temporary directory is removed");
  assert.throws(() => process.kill(env.pid, 0), "The agent was stopped");
});

test("a signed-in profile answers at once and opens nothing", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, "antigravity-acp"));
  fs.writeFileSync(path.join(f.home, "antigravity-acp", "acp_token.json"), JSON.stringify({ refresh_token: "secret" }));
  const opened = [];
  await f.start({ openUrl: (url) => opened.push(url) }).done;
  assert.deepEqual(opened, []);
  assert.deepEqual(inspectAntigravityAccount({ env: f.env }), { state: "ready" });
});

test("SUBSCRIPTION_REQUIRED becomes the subscription message", async (t) => {
  const f = fixture(t, { FAKE_AGY_SCENARIO: "subscription" });
  const flow = f.start({ openUrl: (url) => void fetch(`${new URL(url).searchParams.get("redirect_uri")}?code=fake`) });
  await assert.rejects(flow.done, (error) => error.subscription === true && /eligible Antigravity subscription/.test(error.message));
});

test("a link that isn't Google's loopback sign-in is never opened", async (t) => {
  const f = fixture(t, { FAKE_AGY_SCENARIO: "bad-url" });
  const opened = [];
  await assert.rejects(f.start({ openUrl: (url) => opened.push(url) }).done, /unexpected sign-in link/);
  assert.deepEqual(opened, []);
  assert.equal(inspectAntigravityAccount({ env: f.env }).state, "signed-out");
});

test("cancelling stops the agent and removes its temporary directory", async (t) => {
  const f = fixture(t);
  let flow;
  const captured = new Promise((resolve) => {
    flow = f.start({ openUrl: resolve });
  });
  await captured;
  flow.cancel();
  await assert.rejects(flow.done, (error) => error.cancelled === true);
  const env = f.recorded();
  assert.equal(fs.existsSync(env.TMPDIR), false);
  assert.throws(() => process.kill(env.pid, 0));
  assert.equal(inspectAntigravityAccount({ env: f.env }).state, "signed-out");
});

test("only Google's OAuth URL with a 127.0.0.1 loopback redirect is valid", () => {
  const ok = "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2F&client_id=x";
  assert.equal(validSignInUrl(ok), true);
  for (const bad of [
    ok.replace("https:", "http:"),
    ok.replace("accounts.google.com", "accounts.google.com.evil.example"),
    ok.replace("127.0.0.1", "example.com"),
    ok.replace("%2F&", "evil&"),
    "https://accounts.google.com/o/oauth2/v2/auth",
    "not a url",
  ])
    assert.equal(validSignInUrl(bad), false, bad);
});

test("profiles link skills from ~/.gemini only when present and share history with the default", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-antigravity-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".gemini", "config", "skills"), { recursive: true });
  const base = path.join(root, "default");
  const added = path.join(root, "added");
  prepareAntigravityProfile(base, { home });
  prepareAntigravityProfile(added, { home, history: base });
  assert.equal(fs.realpathSync(path.join(added, "config", "skills")), fs.realpathSync(path.join(home, ".gemini", "config", "skills")));
  assert.equal(fs.existsSync(path.join(added, "antigravity-cli")), false);
  assert.equal(fs.existsSync(path.join(home, ".gemini", "antigravity-cli")), false, "Nothing is created under ~/.gemini");
  assert.equal(fs.realpathSync(path.join(added, "antigravity-acp", "conversations")), fs.realpathSync(path.join(base, "antigravity-acp", "conversations")));
  assert.equal(fs.lstatSync(path.join(added, "antigravity-acp")).isSymbolicLink(), false, "Tokens stay in the profile");
});

test("inspection reads only the email claim and never starts anything", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-antigravity-inspect-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(inspectAntigravityAccount({ env: { GEMINI_HOME: root } }).state, "signed-out");
  fs.mkdirSync(path.join(root, "antigravity-acp"));
  fs.writeFileSync(path.join(root, "antigravity-acp", "acp_token.json"), "{not json");
  assert.deepEqual(inspectAntigravityAccount({ env: { GEMINI_HOME: root } }), { state: "ready" });
  assert.equal(inspectAntigravityAccount({ env: {} }).state, "error");
});

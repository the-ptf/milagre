const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatSecrets, SECRET_TTL } = require("./chat-secrets.cjs");

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-secrets-"));
  const events = [];
  const secrets = createChatSecrets({
    directory,
    active: () => true,
    send: (chatId, event) => events.push({ chatId, event }),
    ...options,
  });
  t.after(() => {
    secrets.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (chatId = "chat") => {
    const result = secrets.definitions(chatId)[0].run({
      title: "Service token",
      description: "Used to deploy the requested app.",
    });
    const id = events.at(-1).event.requestId;
    return { id, result };
  };
  return { directory, events, secrets, request };
}

test("only a private path reaches the agent; exact secret bytes stay outside events", async (t) => {
  const { directory, secrets, request, events } = fixture(t);
  const { id, result } = request();
  const value = "  secret-with-spaces\nand-a-newline  ";
  assert.equal(await secrets.answer("another-chat", id, { secret: [value] }), false);
  assert.equal(await secrets.answer("chat", id, { secret: [value] }), true);
  assert.equal(await secrets.answer("chat", id, { secret: ["replayed"] }), false);
  const response = await result;
  const saved = JSON.parse(response);
  assert.equal(path.dirname(saved.path), directory);
  assert.equal(fs.readFileSync(saved.path, "utf8"), value);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(saved.path).mode & 0o777, 0o600);
  }
  assert.ok(!response.includes(value));
  assert.ok(!JSON.stringify(events).includes("secret-with-spaces"));
  assert.equal(events.at(-1).event.outcome, "answered");
});

test("decline, cancellation, timeout and shutdown never create a file", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { directory, secrets, request } = fixture(t);
  let pending = request();
  await secrets.answer("chat", pending.id, null);
  assert.match(await pending.result, /declined/);
  pending = request();
  secrets.cancel("chat");
  assert.match(await pending.result, /cancelled/);
  pending = request();
  t.mock.timers.tick(5 * 60 * 1000);
  assert.match(await pending.result, /expired/);
  pending = request();
  secrets.close();
  assert.match(await pending.result, /cancelled/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("invalid input leaves the request retryable and cannot appear in an error", async (t) => {
  const { directory, secrets, request } = fixture(t);
  const { id, result } = request();
  for (const answers of [{ secret: [" "] }, { secret: ["a", "b"] }, { secret: ["x".repeat(10001)] }, { other: ["secret-value"] }])
    await assert.rejects(secrets.answer("chat", id, answers), /^Error: Enter a secret/);
  assert.deepEqual(fs.readdirSync(directory), []);
  await secrets.answer("chat", id, { secret: ["valid"] });
  assert.equal(fs.readFileSync(JSON.parse(await result).path, "utf8"), "valid");
});

test("file deletion runs at 24 hours and expired files are removed on restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { directory, secrets, request } = fixture(t);
  const { id, result } = request();
  await secrets.answer("chat", id, { secret: ["disposable"] });
  const saved = JSON.parse(await result);
  t.mock.timers.tick(SECRET_TTL - 1);
  assert.ok(fs.existsSync(saved.path));
  t.mock.timers.tick(1);
  assert.equal(fs.existsSync(saved.path), false);
  secrets.close();
  const expired = path.join(directory, "1000-aaaaaaaa.secret");
  fs.writeFileSync(expired, "expired", { mode: 0o600 });
  const restarted = createChatSecrets({
    directory,
    send() {},
    active: () => true,
  });
  t.after(() => restarted.close());
  assert.equal(fs.existsSync(expired), false);
});

test("unsafe storage fails closed without consuming the request", async (t) => {
  if (process.platform === "win32") return t.skip("Unix permissions");
  const { directory, secrets, request } = fixture(t);
  const { id, result } = request();
  fs.chmodSync(directory, 0o755);
  await assert.rejects(secrets.answer("chat", id, { secret: ["must-not-leak"] }), /Could not save the secret privately/);
  assert.deepEqual(fs.readdirSync(directory), []);
  fs.chmodSync(directory, 0o700);
  await secrets.answer("chat", id, null);
  await result;
});

test("request deadline is shared with clients and late submissions fail even before the timer fires", async (t) => {
  let now = 1000;
  const { directory, secrets, request, events } = fixture(t, {
    now: () => now,
  });
  const { id, result } = request();
  const deadline = events.at(-1).event.secretRequest.expiresAt;
  assert.equal(deadline, now + 5 * 60 * 1000);
  now = deadline;
  assert.equal(await secrets.answer("chat", id, { secret: ["too-late"] }), false);
  assert.match(await result, /expired/);
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(events.at(-1).event.outcome, "cancelled");
});

test("the request stays open until exactly five minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { request, events, directory } = fixture(t);
  const { result } = request();
  t.mock.timers.tick(5 * 60 * 1000 - 1);
  assert.equal(events.at(-1).event.type, "question-request");
  t.mock.timers.tick(1);
  assert.match(await result, /expired/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("a named request offers Save as; the chosen scope saves it and the agent is told", async (t) => {
  const saves = [];
  const values = [];
  const { secrets, events, directory } = fixture(t, {
    onValue: (value) => values.push(value),
    saveAs: {
      offer: async (_chatId, name) => ({ name, project: true, replaces: false }),
      save: async (chatId, input) => saves.push({ chatId, ...input }),
    },
  });
  const tool = secrets.definitions("chat")[0];
  await assert.rejects(tool.run({ title: "Token", description: "Deploys.", name: "PATH" }), /name: PATH is reserved/);
  const result = tool.run({ title: "Token", description: "Deploys.", name: "VERCEL_TOKEN" });
  await new Promise((resolve) => setImmediate(resolve));
  const { requestId, secretRequest } = events.at(-1).event;
  assert.deepEqual(secretRequest.saveAs, { name: "VERCEL_TOKEN", project: true, replaces: false });
  await assert.rejects(secrets.answer("chat", requestId, { secret: ["v-123456789"], save: ["elsewhere"] }), /Choose where to save/);
  assert.equal(await secrets.answer("chat", requestId, { secret: ["v-123456789"], save: ["project"] }), true);
  assert.deepEqual(saves, [{ chatId: "chat", name: "VERCEL_TOKEN", value: "v-123456789", scope: "project", expect: null }]);
  assert.deepEqual(values, ["v-123456789"], "the value joins redaction");
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith(".secret")),
    [],
  );
  const reply = JSON.parse(await result);
  assert.equal(reply.saved, "VERCEL_TOKEN");
  assert.equal(reply.path, undefined, "a saved secret leaves no plaintext file behind");
  assert.match(reply.instructions, /milagre-secrets run --with VERCEL_TOKEN/);
});

test("without Save as or a name, only Don't save is accepted", async (t) => {
  const { secrets, request } = fixture(t);
  const { id, result } = request();
  await assert.rejects(secrets.answer("chat", id, { secret: ["v-123456789"], save: ["all"] }), /Choose where to save/);
  assert.equal(await secrets.answer("chat", id, { secret: ["v-123456789"], save: ["none"] }), true);
  assert.equal(JSON.parse(await result).saved, undefined);
});

test("approveUse asks Allow or Deny; only Allow lets the command run, and nothing answers for an inactive Chat", async (t) => {
  let running = true;
  const { secrets, events } = fixture(t, { active: () => running });
  const allowed = secrets.approveUse("chat", { names: ["DEPLOY_TOKEN"], command: "npx vercel deploy" });
  const asked = events.at(-1).event;
  assert.equal(asked.secretRequest, undefined);
  assert.deepEqual(
    asked.questions[0].options.map((option) => option.label),
    ["Allow", "Deny"],
  );
  assert.match(asked.questions[0].question, /DEPLOY_TOKEN for this command\? npx vercel deploy$/);
  assert.equal(await secrets.answer("chat", asked.requestId, { use: ["Allow"] }), true);
  assert.equal(await allowed, true);
  const denied = secrets.approveUse("chat", { names: ["DEPLOY_TOKEN"], command: "x" });
  await secrets.answer("chat", events.at(-1).event.requestId, { use: ["Deny"] });
  assert.equal(await denied, false);
  const dismissed = secrets.approveUse("chat", { names: ["DEPLOY_TOKEN"], command: "x" });
  await secrets.answer("chat", events.at(-1).event.requestId, null);
  assert.equal(await dismissed, false);
  const cancelled = secrets.approveUse("chat", { names: ["DEPLOY_TOKEN"], command: "x" });
  secrets.cancel("chat");
  assert.equal(await cancelled, false);
  running = false;
  assert.equal(await secrets.approveUse("chat", { names: ["DEPLOY_TOKEN"], command: "x" }), false);
});

test("the first answer claims the request: a second answer while Save as is writing gets nothing", async (t) => {
  let release;
  const writes = [];
  const { secrets, events } = fixture(t, {
    saveAs: {
      offer: async (_chatId, name) => ({ name, project: false, replaces: false, version: 0 }),
      save: (chatId, input) => new Promise((resolve) => ((release = resolve), writes.push(input))),
    },
  });
  const result = secrets.definitions("chat")[0].run({ title: "Token", description: "Deploys.", name: "A_TOKEN" });
  await new Promise((resolve) => setImmediate(resolve));
  const { requestId } = events.at(-1).event;
  const first = secrets.answer("chat", requestId, { secret: ["first-123456"], save: ["all"] });
  assert.equal(await secrets.answer("chat", requestId, { secret: ["second-123456"], save: ["all"] }), false);
  secrets.cancel("chat");
  release();
  assert.equal(await first, true);
  assert.equal(JSON.parse(await result).saved, "A_TOKEN");
  assert.deepEqual(
    writes.map((input) => input.value),
    ["first-123456"],
  );
});

test("a secret that couldn't be stored leaves the request open, so the person can send it again", { skip: process.platform === "win32" }, async (t) => {
  const { directory, secrets, request } = fixture(t);
  const { id, result } = request();
  fs.chmodSync(directory, 0o755);
  await assert.rejects(secrets.answer("chat", id, { secret: ["first-try-123456"] }), /Could not save the secret privately/);
  fs.chmodSync(directory, 0o700);
  assert.equal(await secrets.answer("chat", id, { secret: ["second-try-123456"] }), true);
  assert.equal(fs.readFileSync(JSON.parse(await result).path, "utf8"), "second-try-123456");
});

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
  assert.equal(secrets.answer("another-chat", id, { secret: [value] }), false);
  assert.equal(secrets.answer("chat", id, { secret: [value] }), true);
  assert.equal(secrets.answer("chat", id, { secret: ["replayed"] }), false);
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
  secrets.answer("chat", pending.id, null);
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
    assert.throws(() => secrets.answer("chat", id, answers), /^Error: Enter a secret/);
  assert.deepEqual(fs.readdirSync(directory), []);
  secrets.answer("chat", id, { secret: ["valid"] });
  assert.equal(fs.readFileSync(JSON.parse(await result).path, "utf8"), "valid");
});

test("file deletion runs at 24 hours and expired files are removed on restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { directory, secrets, request } = fixture(t);
  const { id, result } = request();
  secrets.answer("chat", id, { secret: ["disposable"] });
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
  assert.throws(() => secrets.answer("chat", id, { secret: ["must-not-leak"] }), /Could not save the secret privately/);
  assert.deepEqual(fs.readdirSync(directory), []);
  fs.chmodSync(directory, 0o700);
  secrets.answer("chat", id, null);
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
  assert.equal(secrets.answer("chat", id, { secret: ["too-late"] }), false);
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

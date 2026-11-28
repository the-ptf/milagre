const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { createSecretsWiring, isUnattended } = require("./secrets-wiring.cjs");
const { mapStrings } = require("../secrets-stream.cjs");

const PROJECT = "/work/happiergym";
const ORIGIN = "github.com/the-ptf/happiergym";

function fixture(t, { sessions = { 1: {} } } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-secrets-wiring-"));
  fs.chmodSync(dataDir, 0o700);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const handlers = new Map();
  const chats = {
    runs: {},
    turns: new Map(),
    routineTurns: new Set(),
    receiveSpy: [],
    async receive(chatId, event) {
      this.receiveSpy.push({ chatId, event });
    },
  };
  const key = randomBytes(32);
  const scopeStates = { has: () => true, get: async () => ({ sessions }) };
  const wiring = createSecretsWiring({
    dataDir,
    commands: { handle: (name, run) => handlers.set(name, run) },
    chats,
    scopeStates,
    options: { remoteComputers: { masterKey: async () => key } },
    origin: async (folder) => (folder === PROJECT ? ORIGIN : null),
    mcp: () => ({ secretsUrl: async (token) => `http://127.0.0.1:1/secrets/${token}` }),
  });
  t.after(() => wiring.chatSecrets.close());
  const call = (name, ...args) => handlers.get(name)({}, ...args);
  const listTool = (chatId) => wiring.tools(chatId).find((tool) => tool.name === "secrets_list");
  return { dataDir, chats, wiring, call, listTool, scopeStates };
}

test("unattended: hidden Routine and Orchestrator Chats, Heartbeat turns and guarded turns", () => {
  const chats = { turns: new Map(), routineTurns: new Set() };
  assert.equal(isUnattended({}, chats, "c"), false);
  assert.equal(isUnattended({ routine: { routineId: "r", hidden: true } }, chats, "c"), true);
  assert.equal(isUnattended({ routine: { routineId: "r", hidden: false } }, chats, "c"), false);
  assert.equal(isUnattended({ orchestrator: { taskId: "t" } }, chats, "c"), true);
  assert.equal(isUnattended({ orchestrator: { taskId: "t", hidden: false } }, chats, "c"), false);
  chats.routineTurns.add("c");
  assert.equal(isUnattended({}, chats, "c"), true);
  chats.turns.set("d", { guard: { level: 3 } });
  assert.equal(isUnattended({}, chats, "d"), true);
});

test("mapStrings rewrites nested strings and keeps untouched objects identical", () => {
  const event = { type: "step-output", text: "a TOKEN b", step: { detail: ["x", "TOKEN"] }, other: { keep: "yes" } };
  const out = mapStrings(event, (text) => text.replaceAll("TOKEN", "[secret T]"));
  assert.equal(out.text, "a [secret T] b");
  assert.deepEqual(out.step.detail, ["x", "[secret T]"]);
  assert.equal(out.other, event.other);
  assert.equal(
    mapStrings(event, (text) => text),
    event,
  );
});

test("agent events are redacted once a secret is saved", async (t) => {
  const { call, wiring } = fixture(t);
  await call("secrets:set", { name: "VERCEL_TOKEN", value: "vercel-live-token-123", projects: "all" });
  await wiring.agentEnv(`${PROJECT}#1`, { PATH: "/usr/bin" });
  const event = wiring.redact({ type: "step-output", text: "export VERCEL_TOKEN=vercel-live-token-123" });
  assert.equal(event.text, "export VERCEL_TOKEN=[secret VERCEL_TOKEN]");
});

test("secrets:set reads a file secret from an absolute path; secrets:import takes a .env file", async (t) => {
  const { call, dataDir } = fixture(t);
  const keyFile = path.join(dataDir, "AuthKey_ABC.p8");
  fs.writeFileSync(keyFile, "-----BEGIN PRIVATE KEY-----\nabc\n");
  const saved = await call("secrets:set", { name: "ASC_KEY", file: keyFile, projects: [ORIGIN] });
  assert.equal(saved.kind, "file");
  assert.equal(saved.fileName, "AuthKey_ABC.p8");
  await assert.rejects(call("secrets:set", { name: "ASC_KEY", file: "relative.p8", projects: "all" }), /absolute path/);
  const envFile = path.join(dataDir, "asc.env");
  fs.writeFileSync(envFile, "ASC_KEY_ID=ABC123456\nASC_ISSUER_ID=issuer-1234\nPATH=/evil\nEMPTY=\n");
  const result = await call("secrets:import", { file: envFile, projects: [ORIGIN] });
  assert.deepEqual(result.imported, ["ASC_KEY_ID", "ASC_ISSUER_ID"]);
  assert.deepEqual(
    result.skipped.map((entry) => entry.name),
    ["PATH", "EMPTY"],
  );
  assert.deepEqual(
    (await call("secrets:list")).map((secret) => secret.name),
    ["ASC_ISSUER_ID", "ASC_KEY", "ASC_KEY_ID"],
  );
});

test("secrets_list shows names in reach, never values, and says when an unattended run gets none", async (t) => {
  const { call, listTool, chats } = fixture(t, { sessions: { 1: {}, 2: { routine: { routineId: "r", hidden: true } } } });
  await call("secrets:set", { name: "DEPLOY_TOKEN", value: "deploy-value-123456", projects: [ORIGIN], note: "Deploys" });
  await call("secrets:set", { name: "NPM_TOKEN", value: "npm-value-123456", projects: "all", delivery: "ambient" });
  await call("secrets:set", { name: "ELSEWHERE", value: "elsewhere-123456", projects: ["github.com/a/b"] });
  const listed = await listTool(`${PROJECT}#1`).run({});
  assert.deepEqual(JSON.parse(listed), [
    { name: "DEPLOY_TOKEN", kind: "text", note: "Deploys" },
    { name: "NPM_TOKEN", kind: "text", note: null, alreadyInEnvironment: true },
  ]);
  assert.equal(listed.includes("deploy-value"), false);
  assert.equal(await listTool(`${PROJECT}#2`).run({}), "No secrets are available to this Chat.");
  assert.equal(chats.routineTurns.size, 0);
});

test("a replaced value and the Chat's secrets address stay redacted; an archived Chat's address stops working", async (t) => {
  const { call, wiring } = fixture(t, { sessions: { 1: {}, 3: { archived: true } } });
  await call("secrets:set", { name: "VERCEL_TOKEN", value: "old-vercel-value-123", projects: "all" });
  const env = await wiring.agentEnv(`${PROJECT}#1`, { PATH: "/usr/bin" });
  await call("secrets:set", { name: "VERCEL_TOKEN", value: "new-vercel-value-456", projects: "all" });
  await wiring.agentEnv(`${PROJECT}#1`, { PATH: "/usr/bin" });
  const token = env.MILAGRE_SECRETS_URL.split("/").at(-1);
  const event = wiring.redact({ type: "step-output", text: `old-vercel-value-123 new-vercel-value-456 ${env.MILAGRE_SECRETS_URL}` });
  assert.equal(event.text.includes("old-vercel-value-123"), false);
  assert.equal(event.text.includes("new-vercel-value-456"), false);
  assert.equal(event.text.includes(token), false);
  const archived = await wiring.agentEnv(`${PROJECT}#3`, { PATH: "/usr/bin" });
  const archivedToken = archived.MILAGRE_SECRETS_URL.split("/").at(-1);
  await assert.rejects(wiring.request(archivedToken, { action: "list" }), /archived or gone/);
  wiring.chatSecrets.forget(`${PROJECT}#1`);
  await assert.rejects(wiring.request(token, { action: "list" }), /no longer valid/);
});

test("a file secret can't be ambient", async (t) => {
  const { call } = fixture(t);
  await assert.rejects(
    call("secrets:set", { name: "KEY_FILE", value: "x".repeat(20), kind: "file", fileName: "k.p8", projects: "all", delivery: "ambient" }),
    /given per command/,
  );
});

test("a Chat whose Project state can't be read gets nothing", async (t) => {
  const { wiring, scopeStates } = fixture(t);
  const env = await wiring.agentEnv(`${PROJECT}#1`, { PATH: "/usr/bin" });
  const token = env.MILAGRE_SECRETS_URL.split("/").at(-1);
  scopeStates.get = async () => {
    throw new Error("chats.db is busy");
  };
  await assert.rejects(wiring.request(token, { action: "list" }), /chats.db is busy/);
});

test("events the host makes itself are redacted too, not only provider events", async (t) => {
  const { call, wiring, chats } = fixture(t);
  const received = [];
  await call("secrets:set", { name: "VERCEL_TOKEN", value: "vercel-host-made-123", projects: "all" });
  await wiring.agentEnv(`${PROJECT}#1`, { PATH: "/usr/bin" });
  chats.receiveSpy = received;
  await chats.receive(`${PROJECT}#1`, { type: "step-output", id: "setup", text: "token vercel-host-made-123" });
  assert.equal(received[0].event.text, "token [secret VERCEL_TOKEN]");
});

test("Save as over an existing secret keeps its policy, and a card opened before a change saves nothing", async (t) => {
  const { call, wiring, chats } = fixture(t);
  const chatId = `${PROJECT}#1`;
  chats.runs[chatId] = {};
  await call("secrets:set", { name: "DEPLOY_TOKEN", value: "old-value-123456", projects: "all", askEachUse: true, note: "Vercel" });
  const ask = async () => {
    const result = wiring.chatSecrets.definitions(chatId)[0].run({ title: "Token", description: "Deploys.", name: "DEPLOY_TOKEN" });
    await new Promise((resolve) => setImmediate(resolve));
    return { result, request: chats.receiveSpy.at(-1).event };
  };
  const first = await ask();
  assert.deepEqual(first.request.secretRequest.saveAs, { name: "DEPLOY_TOKEN", project: true, replaces: true, version: 1 });
  await wiring.chatSecrets.answer(chatId, first.request.requestId, { secret: ["new-value-123456"], save: ["all"] });
  assert.equal(JSON.parse(await first.result).saved, "DEPLOY_TOKEN");
  const [kept] = await call("secrets:list");
  assert.deepEqual([kept.askEachUse, kept.note, kept.version], [true, "Vercel", 2]);
  const stale = await ask();
  await call("secrets:update", { name: "DEPLOY_TOKEN", note: "changed meanwhile" });
  await wiring.chatSecrets.answer(chatId, stale.request.requestId, { secret: ["stale-value-123456"], save: ["all"] });
  const reply = JSON.parse(await stale.result);
  assert.match(reply.saved, /changed while the card was open/);
  assert.ok(reply.path, "the value still reaches the agent as a one-off file");
  assert.equal((await wiring.values()).find((secret) => secret.name === "DEPLOY_TOKEN").value, "new-value-123456");
});

test("a browser's passwords file becomes logins by site, shown to the agent by site and typed only through the browser", async (t) => {
  const { call, listTool, dataDir } = fixture(t);
  const csv = path.join(dataDir, "Chrome Passwords.csv");
  fs.writeFileSync(
    csv,
    "name,url,username,password,note\nvercel,https://vercel.com/login,me@x.com,vercel-pass-123456,\nold,http://intranet.example/login,me,intranet-pass-123456,\nbroken,nowhere,me,pass-123456,\n",
  );
  const result = await call("secrets:import-logins", { file: csv, remove: true });
  assert.equal(result.removed, false);
  assert.equal(fs.existsSync(csv), true, "an export with rows that weren't saved stays, so nothing is lost");
  assert.equal(result.imported.length, 1);
  assert.match(result.imported[0], /^LOGIN_VERCEL_COM_/);
  assert.deepEqual(
    result.skipped.map((entry) => entry.site),
    ["nowhere", "http://intranet.example"],
    "a login without https is never saved",
  );
  const [login] = await call("secrets:list");
  assert.deepEqual(login.login, { origin: "https://vercel.com", username: "me@x.com" });
  const listed = await listTool(`${PROJECT}#1`).run({});
  assert.deepEqual(JSON.parse(listed), [{ name: result.imported[0], kind: "login", note: null, site: "https://vercel.com" }]);
  assert.equal(listed.includes("vercel-pass"), false);
  const clean = path.join(dataDir, "clean.csv");
  fs.writeFileSync(clean, "url,username,password\nhttps://linear.app,me,linear-pass-123456\n");
  assert.equal((await call("secrets:import-logins", { file: clean, remove: true })).removed, true);
  assert.equal(fs.existsSync(clean), false, "a fully imported export is deleted");
  await assert.rejects(
    call("secrets:set", {
      name: "LOGIN_AMBIENT",
      kind: "login",
      login: { origin: "https://a.com", username: "u" },
      value: "pass-123456",
      projects: "all",
      delivery: "ambient",
    }),
    /never in the environment/,
  );
});

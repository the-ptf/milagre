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
  const chats = { runs: {}, turns: new Map(), routineTurns: new Set(), receive: async () => {} };
  const key = randomBytes(32);
  const wiring = createSecretsWiring({
    dataDir,
    commands: { handle: (name, run) => handlers.set(name, run) },
    chats,
    scopeStates: { has: () => true, get: async () => ({ sessions }) },
    options: { remoteComputers: { masterKey: async () => key } },
    origin: async (folder) => (folder === PROJECT ? ORIGIN : null),
    mcp: () => ({ secretsUrl: async (token) => `http://127.0.0.1:1/secrets/${token}` }),
  });
  t.after(() => wiring.chatSecrets.close());
  const call = (name, ...args) => handlers.get(name)({}, ...args);
  const listTool = (chatId) => wiring.tools(chatId).find((tool) => tool.name === "secrets_list");
  return { dataDir, chats, wiring, call, listTool };
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

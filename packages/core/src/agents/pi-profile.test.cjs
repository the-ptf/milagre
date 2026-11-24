const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPiModels, hiddenProviders, piEnvironment, piReady } = require("./pi-profile.cjs");
const { ROUTES, fakeOllama } = require("./fixtures/fake-ollama.cjs");

function folders(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-pi-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDir = path.join(root, "user");
  const profile = path.join(root, "profile");
  fs.mkdirSync(userDir);
  return { userDir, profile };
}

const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const DOWN = async () => {
  throw new Error("connect ECONNREFUSED");
};

const HOSTED = [
  { id: "z-ai/glm-4.6", name: "GLM 4.6", provider: "openrouter", cost: { input: 0.4, output: 1.75 } },
  { id: "gpt-5.6-codex", name: "GPT-5.6 Codex", provider: "openai-codex" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic" },
  { id: "qwen3:8b", provider: "ollama" },
];

test("the profile shares the user's sign-ins and catalogs, and copies their custom providers under Milagre's Ollama", async (t) => {
  const { userDir, profile } = folders(t);
  write(path.join(userDir, "auth.json"), { openrouter: { type: "api_key", key: "sk-or" } });
  write(path.join(userDir, "models-store.json"), { openrouter: { models: [] } });
  write(path.join(userDir, "models.json"), { providers: { llamacpp: { baseUrl: "http://127.0.0.1:8080/v1" }, ollama: { baseUrl: "http://elsewhere" } } });
  const { fetchImpl } = fakeOllama(ROUTES);
  const list = createPiModels({ userDir, fetchImpl, ask: async () => HOSTED });
  const result = await list({ command: "pi", profile, env: {} });

  assert.equal(fs.readlinkSync(path.join(profile, "auth.json")), path.join(userDir, "auth.json"));
  assert.equal(fs.readlinkSync(path.join(profile, "models-store.json")), path.join(userDir, "models-store.json"));
  const written = JSON.parse(fs.readFileSync(path.join(profile, "models.json"), "utf8"));
  assert.deepEqual(Object.keys(written.providers).sort(), ["llamacpp", "ollama"]);
  assert.equal(written.providers.ollama.baseUrl, "http://127.0.0.1:11434/v1");
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["pi:ollama/qwen3:8b", "pi:ollama/coder:64k", "pi:openrouter/z-ai/glm-4.6", "pi:anthropic/claude-sonnet-5-5"],
  );
});

test("subscription sign-ins stay out, and an Anthropic account sign-in hides Anthropic", async (t) => {
  const { userDir, profile } = folders(t);
  write(path.join(userDir, "auth.json"), { anthropic: { type: "oauth" }, openrouter: { type: "api_key", key: "sk-or" } });
  const list = createPiModels({ userDir, fetchImpl: DOWN, ask: async () => HOSTED });
  const result = await list({ command: "pi", profile, env: {} });
  assert.equal(result.local, null);
  assert.deepEqual(
    result.models.map((model) => [model.id, model.recommended]),
    [["pi:openrouter/z-ai/glm-4.6", true]],
  );
  assert.equal((await hiddenProviders(userDir)).has("openai-codex"), true);
});

test("hosted models are asked once per few minutes, and again after invalidate", async (t) => {
  const { userDir, profile } = folders(t);
  let asked = 0;
  let clock = 0;
  const list = createPiModels({
    userDir,
    fetchImpl: DOWN,
    now: () => clock,
    ask: async () => {
      asked += 1;
      return HOSTED.slice(0, 1);
    },
  });
  await list({ command: "pi", profile, env: {} });
  await list({ command: "pi", profile, env: {} });
  assert.equal(asked, 1);
  clock += 6 * 60_000;
  await list({ command: "pi", profile, env: {} });
  assert.equal(asked, 2);
  list.invalidate();
  await list({ command: "pi", profile, env: {} });
  assert.equal(asked, 3);
});

test("Pi is ready with a key in the environment, a connected provider or Ollama, and not with only subscription sign-ins", async (t) => {
  const { userDir } = folders(t);
  assert.equal(await piReady({ env: {}, userDir, fetchImpl: DOWN }), false);
  assert.equal(await piReady({ env: { OPENROUTER_API_KEY: "sk-or" }, userDir, fetchImpl: DOWN }), true);
  write(path.join(userDir, "auth.json"), { "openai-codex": { type: "oauth" } });
  assert.equal(await piReady({ env: {}, userDir, fetchImpl: DOWN }), false);
  write(path.join(userDir, "auth.json"), { groq: { type: "api_key", key: "gsk" } });
  assert.equal(await piReady({ env: {}, userDir, fetchImpl: DOWN }), true);
  fs.rmSync(path.join(userDir, "auth.json"));
  assert.equal(await piReady({ env: {}, userDir, fetchImpl: fakeOllama({ "/api/version": { version: "0.13" } }).fetchImpl }), true);
});

test("Pi runs offline from the profile, without a Claude subscription token", () => {
  const env = piEnvironment({ PATH: "/bin", ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat", OPENROUTER_API_KEY: "sk-or" }, "/profile");
  assert.deepEqual(env, { PATH: "/bin", OPENROUTER_API_KEY: "sk-or", PI_CODING_AGENT_DIR: "/profile", PI_OFFLINE: "1", PI_TELEMETRY: "0" });
});

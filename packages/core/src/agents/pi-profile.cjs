const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { piModels } = require("@milagre/shared/pi-models");
const { ollamaProvider, ollamaRunning, readOllamaModels } = require("./ollama.cjs");
const { PiRpc } = require("./pi-rpc.cjs");
const { execCommand } = require("./command.cjs");

// Pi runs from a profile Milagre owns (PI_CODING_AGENT_DIR), so the user's own Pi extensions, skills and settings
// never load. The profile links the user's sign-ins (auth.json, written by `pi auth login`) and model catalogs
// (models-store.json, OpenRouter's list among them), and copies their custom providers from models.json, so every
// provider the user connected to Pi shows in Milagre. Pi locks the resolved file, so a linked auth.json is safe.
const LINKED = ["auth.json", "models-store.json"];
// Subscription sign-ins Milagre covers with its own providers (Claude, Codex, Antigravity). Anthropic's consumer
// terms don't allow a Pro or Max login in another harness, so an Anthropic OAuth sign-in hides Anthropic too.
const SUBSCRIPTION_PROVIDERS = new Set(["openai-codex", "google-gemini-cli", "google-antigravity"]);
const HIDDEN_ENV = ["ANTHROPIC_OAUTH_TOKEN"];
// Pi's single-key providers (`pi --help`); any of these in the environment gives Pi models without a sign-in.
const KEY_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "BASETEN_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "HF_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
];
const LIST_TIMEOUT_MS = 30_000;
const CLOUD_TTL_MS = 5 * 60_000;
const CATALOG_REFRESH_MS = 6 * 60 * 60_000;

const NO_MODELS_MESSAGE =
  "Pi has no model to run. Start Ollama with a model that can call tools (`ollama pull qwen3`), or connect a provider with `pi auth login <provider>` in a terminal, then send your message again.";
const HIDDEN_MODEL_MESSAGE = "Milagre doesn't run subscription sign-ins through Pi. Pick this model in its own provider (Claude, Codex or Antigravity).";

const userPiDir = () => path.join(os.homedir(), ".pi", "agent");

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeIfChanged(file, text) {
  const current = await fs.readFile(file, "utf8").catch(() => null);
  if (current === text) return;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, text, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/** Points the profile's sign-ins and catalogs at the user's own Pi files, where they exist. */
async function linkUserPi(profile, userDir = userPiDir()) {
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  for (const name of LINKED) {
    const target = path.join(userDir, name);
    const link = path.join(profile, name);
    if (!(await fs.stat(target).catch(() => null))?.isFile()) continue;
    if ((await fs.readlink(link).catch(() => null)) === target) continue;
    await fs.rm(link, { force: true });
    await fs.symlink(target, link);
  }
}

/** The providers Milagre leaves out of Pi: subscription sign-ins, and Anthropic when Pi signed in with an account. */
async function hiddenProviders(userDir = userPiDir()) {
  const hidden = new Set(SUBSCRIPTION_PROVIDERS);
  const auth = await readJson(path.join(userDir, "auth.json"));
  if (auth?.anthropic?.type === "oauth") hidden.add("anthropic");
  return hidden;
}

/** Whether Pi could run any model: Ollama answers, a key is in the environment, or the user connected a provider. */
async function piReady({ env = process.env, userDir = userPiDir(), fetchImpl } = {}) {
  if (KEY_ENV.some((name) => typeof env[name] === "string" && env[name].trim())) return true;
  const hidden = await hiddenProviders(userDir);
  const auth = await readJson(path.join(userDir, "auth.json"));
  if (Object.keys(auth ?? {}).some((provider) => !hidden.has(provider))) return true;
  const custom = await readJson(path.join(userDir, "models.json"));
  if (Object.keys(custom?.providers ?? {}).some((provider) => provider !== "ollama")) return true;
  return ollamaRunning({ env, ...(fetchImpl ? { fetchImpl } : {}) });
}

/** The profile's models.json: the user's custom providers, with Milagre's `ollama` provider in place of theirs. */
async function writeModelsConfig(profile, entries, { env = process.env, userDir = userPiDir() } = {}) {
  const { ollama: _theirs, ...providers } = (await readJson(path.join(userDir, "models.json")))?.providers ?? {};
  if (entries?.length) providers.ollama = ollamaProvider(entries, env);
  await writeIfChanged(path.join(profile, "models.json"), `${JSON.stringify({ providers }, null, 2)}\n`);
}

/** Pi's environment for the profile: its own directory, offline, no install telemetry, no Claude subscription token. */
function piEnvironment(env, profile) {
  const next = { ...env, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  for (const name of HIDDEN_ENV) delete next[name];
  return next;
}

/** Asks a short-lived Pi which hosted models it can run with the profile's credentials. */
async function askPiModels({ command, env, createRpc = (options) => new PiRpc(options) }) {
  const rpc = createRpc({
    command,
    args: ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-mcp", "--no-context-files"],
    cwd: os.tmpdir(),
    env,
    name: "Pi",
  });
  rpc.on("event", () => {});
  rpc.on("exit", () => {});
  rpc.start();
  try {
    const data = await rpc.request("get_available_models", {}, { timeoutMs: LIST_TIMEOUT_MS });
    return Array.isArray(data?.models) ? data.models : [];
  } finally {
    await rpc.close().catch(() => {});
  }
}

/** Refreshes the catalogs Pi fetches (OpenRouter's list for the key, among others); RPC mode only reads them. */
function refreshPiCatalogs({ command, env, exec = execCommand }) {
  const { PI_OFFLINE: _offline, ...online } = env;
  return new Promise((resolve) => {
    exec(command, ["update", "--models"], { cwd: os.tmpdir(), env: online, timeout: LIST_TIMEOUT_MS }, () => resolve());
  });
}

/** Lists Pi's models for a profile: local Ollama models read fresh, hosted ones cached for a few minutes. */
function createPiModels({ userDir = userPiDir(), now = Date.now, ask = askPiModels, refreshCatalogs = null, fetchImpl } = {}) {
  const cloud = new Map();
  const refreshed = new Map();
  async function hosted({ command, profile, env }) {
    const cached = cloud.get(profile);
    if (cached && now() - cached.at < CLOUD_TTL_MS) return cached.models;
    const models = await ask({ command, env }).catch(() => cached?.models ?? []);
    cloud.set(profile, { at: now(), models });
    if (refreshCatalogs && now() - (refreshed.get(profile) ?? 0) > CATALOG_REFRESH_MS) {
      refreshed.set(profile, now());
      void Promise.resolve(refreshCatalogs({ command, env }))
        .then(() => cloud.delete(profile))
        .catch(() => {});
    }
    return models;
  }
  const list = async ({ command, profile, env = process.env }) => {
    if (!profile) throw new Error("Milagre has no Pi profile on this computer.");
    await linkUserPi(profile, userDir);
    const local = await readOllamaModels({ env, ...(fetchImpl ? { fetchImpl } : {}) }).catch(() => null);
    await writeModelsConfig(profile, local, { env, userDir });
    const hidden = await hiddenProviders(userDir);
    const reported = (command ? await hosted({ command, profile, env }) : []).filter((model) => model?.provider !== "ollama" && !hidden.has(model?.provider));
    return { local, reported, models: piModels(local, reported), hidden };
  };
  list.invalidate = () => cloud.clear();
  return list;
}

const listPiModels = createPiModels({ refreshCatalogs: refreshPiCatalogs });

module.exports = {
  HIDDEN_MODEL_MESSAGE,
  NO_MODELS_MESSAGE,
  askPiModels,
  createPiModels,
  hiddenProviders,
  linkUserPi,
  listPiModels,
  piEnvironment,
  piReady,
  refreshPiCatalogs,
  userPiDir,
  writeIfChanged,
  writeModelsConfig,
};

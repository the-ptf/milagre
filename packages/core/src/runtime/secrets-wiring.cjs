const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { SECRET_LIMITS, parseDotenv, secretNameProblem, secretRedactor } = require("@milagre/shared/secrets");
const { createSecretsVault } = require("../secrets-vault.cjs");
const { createSecretsAccess } = require("../secrets-access.cjs");
const { createChatSecrets } = require("../chat-secrets.cjs");

function mapStrings(value, change, depth = 0) {
  if (typeof value === "string") return change(value);
  if (!value || typeof value !== "object" || depth > 16) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = mapStrings(item, change, depth + 1);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? next : value;
  }
  let next = null;
  for (const [key, item] of Object.entries(value)) {
    const mapped = mapStrings(item, change, depth + 1);
    if (mapped !== item) (next ??= { ...value })[key] = mapped;
  }
  return next ?? value;
}

/** Turns a person isn't there for: Routine runs and triggers, Heartbeats, babysitting, wakes and Orchestrator tasks. */
function isUnattended(session, chats, chatId) {
  const hiddenRun = (mark) => Boolean(mark) && mark.hidden !== false;
  return hiddenRun(session?.routine) || hiddenRun(session?.orchestrator) || chats.routineTurns.has(chatId) || Boolean(chats.turns.get(chatId)?.guard?.level);
}

async function readSmallFile(file, what) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error(`${what} must be an absolute path.`);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`${what} is not a file.`);
  if (stat.size > SECRET_LIMITS.valueBytes) throw new Error(`${what} is larger than ${SECRET_LIMITS.valueBytes / 1024} KB.`);
  return fs.readFile(file, "utf8");
}

/**
 * Named secrets for agents (issue #1239): the vault, the `milagre-secrets` command and its loopback address, ambient
 * env, `secrets_list`, transcript redaction, the owner's `secrets:*` commands, and `request_secret`'s one-off secrets.
 */
function createSecretsWiring({ dataDir, commands, chats, scopeStates, options = {}, origin, mcp, computerId = () => os.hostname() }) {
  const vault = createSecretsVault({ dataDir, masterKey: async () => (await options.remoteComputers?.masterKey?.()) ?? null, computerId });
  let redactor = null;
  const refresh = async () => {
    const values = await vault.values().catch(() => []);
    redactor = values.length ? secretRedactor(values) : null;
  };
  vault.onChange(() => void refresh());
  void refresh();

  async function target(chatId) {
    const projectPath = projectOfKey(chatId);
    const state = scopeStates.has(projectPath) ? await scopeStates.get(projectPath).catch(() => null) : null;
    const session = state?.sessions?.[sessionIdFromKey(chatId)];
    const found = isLinkScopeKey(projectPath) || !path.isAbsolute(projectPath) ? null : await Promise.resolve(origin(projectPath)).catch(() => null);
    return { origin: found ?? null, unattended: isUnattended(session, chats, chatId) };
  }

  const access = createSecretsAccess({ vault, dataDir, secretsUrl: (token) => mcp().secretsUrl(token), target });
  const chatSecrets = createChatSecrets({
    directory: path.join(dataDir, "chat-secrets"),
    send: (chatId, event) => chats.receive(chatId, event),
    active: (chatId) => Boolean(chats.runs[chatId]),
  });

  commands.handle("secrets:status", () => vault.status());
  commands.handle("secrets:list", () => vault.list());
  commands.handle("secrets:log", (_context, request = {}) => vault.log(request?.name ?? null));
  commands.handle("secrets:delete", (_context, request) => vault.remove(String(request?.name ?? "")));
  commands.handle("secrets:set", async (_context, request = {}) => {
    const { file, ...rest } = request ?? {};
    if (file === undefined) return vault.set(rest);
    const value = await readSmallFile(file, "The secret's file");
    return vault.set({ kind: "file", fileName: path.basename(file), ...rest, value });
  });
  commands.handle("secrets:import", async (_context, request = {}) => {
    const { file, ...fields } = request ?? {};
    const imported = [];
    const skipped = [];
    for (const { name, value } of parseDotenv(await readSmallFile(file, "The .env file"))) {
      const problem = value ? secretNameProblem(name) : "No value.";
      if (problem) {
        skipped.push({ name, reason: problem });
        continue;
      }
      try {
        await vault.set({ ...fields, name, value, kind: "text" });
        imported.push(name);
      } catch (error) {
        skipped.push({ name, reason: error.message });
      }
    }
    return { imported, skipped };
  });

  const listTool = (chatId) => ({
    name: "secrets_list",
    description:
      "List the secrets this Chat may use: names, kinds and notes, never values. Run a command with them through the shell: `milagre-secrets run --with NAME[,NAME] -- <command>` puts each in that one command's environment (a file secret's variable holds a temporary file path). Every use is logged. If a secret you need is missing, ask with request_secret.",
    input: {},
    readOnly: true,
    run: async () => {
      const { locked, secrets } = await vault.reachable(await target(chatId));
      if (locked) return "Secrets are locked on this computer: the person needs to open Milagre here, or set up a computer key for unattended access.";
      if (!secrets.length) return "No secrets are available to this Chat.";
      return JSON.stringify(
        secrets.map(({ name, kind, note, delivery }) => ({ name, kind, note, ...(delivery === "ambient" ? { alreadyInEnvironment: true } : {}) })),
        null,
        2,
      );
    },
  });

  return {
    vault,
    chatSecrets,
    request: (token, body) => access.request(token, body),
    agentEnv: async (chatId, env) => {
      await refresh();
      return access.agentEnv(chatId, env);
    },
    redact: (event) => (redactor ? mapStrings(event, redactor) : event),
    values: () => vault.values().catch(() => []),
    tools: (chatId) => [...chatSecrets.definitions(chatId), listTool(chatId)],
  };
}

module.exports = { createSecretsWiring, isUnattended, mapStrings };

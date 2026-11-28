const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { SECRET_LIMITS, loginName, parseDotenv, parseLoginCsv, secretNameProblem, secretRedactor } = require("@milagre/shared/secrets");
const { createSecretsVault } = require("../secrets-vault.cjs");
const { createSecretsAccess } = require("../secrets-access.cjs");
const { createSecretsSync } = require("../secrets-sync.cjs");
const { createChatSecrets } = require("../chat-secrets.cjs");
const { createSecretStream, mapStrings } = require("../secrets-stream.cjs");
const { originId } = require("@milagre/shared/project-origin");
const git = require("../git/client.cjs").createGit().read;

const currentOrigin = (projectPath) =>
  git.checked(projectPath, ["remote", "get-url", "origin"]).then(
    ({ stdout }) => originId(stdout),
    () => null,
  );

const RETIRED_MS = 24 * 60 * 60 * 1000;
const LOGIN_CSV_BYTES = 5 * 1024 * 1024;

/** Turns a person isn't there for: Routine runs and triggers, Heartbeats, babysitting, wakes and Orchestrator tasks. */
function isUnattended(session, chats, chatId) {
  const hiddenRun = (mark) => Boolean(mark) && mark.hidden !== false;
  return hiddenRun(session?.routine) || hiddenRun(session?.orchestrator) || chats.routineTurns.has(chatId) || Boolean(chats.turns.get(chatId)?.guard?.level);
}

async function readSmallFile(file, what, limit = SECRET_LIMITS.valueBytes) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error(`${what} must be an absolute path.`);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`${what} is not a file.`);
  if (stat.size > limit) throw new Error(`${what} is larger than ${Math.round(limit / 1024)} KB.`);
  return fs.readFile(file, "utf8");
}

/**
 * Saves each login of a browser's or password manager's CSV export under its site's login name; a row that fails is
 * reported. With `remove`, the export (every password in plain text) is deleted once its logins are saved.
 */
async function importLogins(vault, { file, projects = "all", remove = false } = {}) {
  const parsed = parseLoginCsv(await readSmallFile(file, "The passwords file", LOGIN_CSV_BYTES));
  const imported = [];
  const skipped = parsed.skipped.map(({ row, site, reason }) => ({ name: `line ${row}`, site, reason }));
  for (const row of parsed.logins) {
    const name = loginName(row.origin, row.username);
    try {
      await vault.set({ name, kind: "login", login: { origin: row.origin, username: row.username }, value: row.password, note: row.note, projects });
      imported.push(name);
    } catch (error) {
      skipped.push({ name: `line ${row.line}`, site: row.origin, reason: error.message });
    }
  }
  const removed =
    remove && imported.length > 0 && skipped.length === 0
      ? await fs.rm(file).then(
          () => true,
          () => false,
        )
      : false;
  return { imported, skipped, removed };
}

/**
 * Named secrets for agents (issue #1239): the vault, the `milagre-secrets` command and its loopback address, ambient
 * env, `secrets_list`, transcript redaction, the owner's `secrets:*` commands, and `request_secret`'s one-off secrets.
 */
function createSecretsWiring({
  dataDir,
  commands,
  chats,
  scopeStates,
  options = {},
  origin = currentOrigin,
  mcp,
  computerId = () => options.remoteComputers?.thisMac?.() || os.hostname(),
  now = Date.now,
}) {
  const vault = createSecretsVault({ dataDir, masterKey: async () => (await options.remoteComputers?.masterKey?.()) ?? null, computerId });
  const retired = new Map();
  let redactor = null;
  const refresh = async () => {
    const live = new Map((await vault.values().catch(() => [])).map((secret) => [`${secret.kind}:${secret.value}`, secret]));
    for (const [key, entry] of retired) if (live.has(key) || now() - entry.at > RETIRED_MS) retired.delete(key);
    for (const [key, secret] of lastLive) if (!live.has(key)) retired.set(key, { secret, at: now() });
    lastLive = live;
    const tokens = access.tokens().map((token) => ({ name: "MILAGRE_SECRETS_URL", value: token }));
    const all = [...live.values(), ...[...retired.values()].map((entry) => entry.secret), ...tokens];
    redactor = all.length ? secretRedactor(all) : null;
  };
  let lastLive = new Map();
  const stream = createSecretStream({ redactor: () => redactor });

  async function target(chatId) {
    const projectPath = projectOfKey(chatId);
    const state = scopeStates.has(projectPath) ? await scopeStates.get(projectPath) : null;
    const session = state?.sessions?.[sessionIdFromKey(chatId)];
    if (state && (!session || session.archived)) throw Object.assign(new Error("This Chat is archived or gone."), { status: 401 });
    const found = isLinkScopeKey(projectPath) || !path.isAbsolute(projectPath) ? null : await Promise.resolve(origin(projectPath)).catch(() => null);
    return { origin: found ?? null, unattended: isUnattended(session, chats, chatId) };
  }

  const chatSecrets = Object.assign(
    createChatSecrets({
      directory: path.join(dataDir, "chat-secrets"),
      send: (chatId, event) => chats.receive(chatId, event),
      active: (chatId) => Boolean(chats.runs[chatId]),
      onValue: (value) => {
        retired.set(`text:${value}`, { secret: { name: "SECRET", kind: "text", value }, at: now() });
        void refresh();
      },
      saveAs: {
        offer: async (chatId, name) => {
          if (!(await vault.status()).unlocked) return null;
          const { origin: found } = await target(chatId);
          const existing = (await vault.list()).find((secret) => secret.name === name);
          return { name, project: Boolean(found), replaces: Boolean(existing), version: existing?.version ?? 0, changedOn: existing?.changedOn ?? null };
        },
        save: async (chatId, { name, value, scope, expect }) => {
          const where = await target(chatId);
          if (scope === "project" && !where.origin) throw new Error("This Chat's Project has no Git origin.");
          await vault.set({ name, value, projects: scope === "project" ? [where.origin] : "all" }, { expect, keepPolicy: true });
        },
      },
    }),
    {
      forget: (chatId) => {
        access.forget(chatId);
        void refresh();
      },
    },
  );
  const access = createSecretsAccess({
    vault,
    dataDir,
    secretsUrl: (token) => mcp().secretsUrl(token),
    target,
    redactText: (text) => (redactor ? redactor(text) : text),
    approve: (chatId, request) => chatSecrets.approveUse(chatId, request),
  });
  const receive = chats.receive.bind(chats);
  chats.receive = (chatId, event) => receive(chatId, redactor ? mapStrings(event, redactor) : event);
  require("../chat-browser-tools.cjs").useLogins({
    resolve: async (chatId, name) => vault.login({ name, target: await target(chatId), chatId }),
  });
  vault.onChange(() => {
    void refresh();
    options.emit?.("secrets:changed", {});
  });
  void refresh();

  const sync = createSecretsSync({ vault, remote: options.remoteComputers, dataDir });
  commands.handle("secrets:digest", () => sync.digest());
  commands.handle("secrets:push", (context, request) => sync.receive(request, context?.peerKey));
  commands.handle("secrets:forget-from", (context, request) => sync.forgetFrom(request, context?.peerKey));
  commands.handle("secrets:sharing", () => sync.sharing());
  commands.handle("secrets:share", (_context, request) => sync.share(request));
  commands.handle("secrets:status", () => vault.status());
  commands.handle("secrets:list", () => vault.list());
  commands.handle("secrets:log", (_context, request = {}) => vault.log(request?.name ?? null));
  commands.handle("secrets:update", (_context, request = {}) => {
    const { name, ...patch } = request ?? {};
    return vault.update(String(name ?? ""), patch);
  });
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
  commands.handle("secrets:import-logins", (_context, request) => importLogins(vault, request ?? {}));

  const listTool = (chatId) => ({
    name: "secrets_list",
    description:
      'List the secrets this Chat may use: names, kinds and notes, never values. Run a command with them through the shell: `milagre-secrets run --with NAME[,NAME] -- <command>` puts each in that one command\'s environment (a file secret\'s variable holds a temporary file path). A login (kind login, with its site) goes only into a Browser panel page on that site: browser_fill with login { name, field: "username" or "password" } types it without showing it to you. Every use is logged. If a secret you need is missing, ask with request_secret.',
    input: {},
    readOnly: true,
    run: async () => {
      const { locked, secrets } = await vault.reachable(await target(chatId));
      if (locked) return "Secrets are locked on this computer: the person needs to open Milagre here, or set up a computer key for unattended access.";
      if (!secrets.length) return "No secrets are available to this Chat.";
      return JSON.stringify(
        secrets.map(({ name, kind, note, delivery, login }) => ({
          name,
          kind,
          note,
          ...(login ? { site: login.origin } : {}),
          ...(delivery === "ambient" ? { alreadyInEnvironment: true } : {}),
        })),
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
      const next = await access.agentEnv(chatId, env);
      await refresh();
      return next;
    },
    forward: (chatId, event, deliver) => stream.forward(chatId, event, deliver),
    redact: (event) => (redactor ? mapStrings(event, redactor) : event),
    redactResult: (result) => (redactor ? mapStrings(result, redactor) : result),
    values: () => vault.values().catch(() => []),
    tools: (chatId) => [...chatSecrets.definitions(chatId), listTool(chatId)],
  };
}

module.exports = { createSecretsWiring, isUnattended };

const fs = require("node:fs/promises");
const path = require("node:path");
const { botIdFromName } = require("@milagre/shared/bots");
const { PROVIDERS } = require("@milagre/shared/providers");
const { createBotHome, readBrief, writeBrief, writeInstructions } = require("./home.cjs");
const { readMemory, saveMemoryByVictor } = require("./memory.cjs");
const { TEMPLATES, renderBrief, setupFields } = require("./templates.cjs");

// Bots (docs/adr/0010-bots-are-hidden-projects.md): each bot is a hidden Project, its home <dataDir>/bots/<id>/, opened
// by the runtime without entering the registry or the recent list; its thread is one ordinary Chat there. Everything
// else a bot keeps is in angelo.db (store.cjs). The runtime hands this service the few things it needs: opening and
// closing a home, the Chats (`chats.send`, `chats.emptyChat`), the agent sessions and the cached state of a Project.

const OFF = "Bots are off. Turn them on in Settings › Experimental.";
const NAME_MAX = 40;
const ROLE_MAX = 120;
const PREVIEW_MAX = 120;

const threadKey = (bot) => `${bot.homePath}#${bot.threadSessionId}`;

function cleanName(value) {
  const name = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || !botIdFromName(name) || name.length > NAME_MAX) throw new Error(`Give the bot a name of up to ${NAME_MAX} letters.`);
  return name;
}

function createBots({
  dataDir,
  store,
  chats,
  agents,
  cachedState = () => undefined,
  openHome,
  closeHome = async () => {},
  projects = async () => [],
  emit = () => {},
  now = Date.now,
  // Whose bots these are, as the instructions and the copy name them.
  owner = "Victor",
}) {
  const botsDir = path.join(dataDir, "bots");
  let records = store.listBots();
  const refresh = () => (records = store.listBots());
  const creating = new Set();

  const enabled = () => store.enabled();
  function requireEnabled() {
    if (!enabled()) throw new Error(OFF);
  }
  function requireBot(id) {
    const bot = records.find((record) => record.id === id);
    if (!bot) throw new Error("That bot no longer exists.");
    return bot;
  }
  function requireActive(bot) {
    requireEnabled();
    if (bot.paused) throw new Error(`${bot.name} is paused.`);
  }

  function checkUnique(name, except) {
    const id = botIdFromName(name);
    const taken = records.some((bot) => bot.id !== except && (bot.id === id || bot.name.toLowerCase() === name.toLowerCase()));
    if (taken || (except === undefined && creating.has(id))) throw new Error(`A bot named ${name} already exists.`);
  }
  // A bot watches Projects open in Milagre: their paths as the registry has them.
  async function checkedProjects(value) {
    const list = Array.isArray(value) ? [...new Set(value)] : [];
    if (!list.length) throw new Error("Choose at least one Project to watch.");
    const known = new Set((await projects()).map((project) => project.path));
    const missing = list.find((projectPath) => typeof projectPath !== "string" || !known.has(projectPath));
    if (missing !== undefined) throw new Error("Open each Project in Milagre before a bot watches it.");
    return list;
  }

  function summary(bot) {
    const state = cachedState(bot.homePath);
    const session = state?.sessions?.[bot.threadSessionId];
    // An unloaded thread's messages aren't in the state (message-store.cjs): its preview waits until it loads again.
    const last = state?.messages?.findLast?.((message) => message.session_id === bot.threadSessionId && message.body);
    return {
      ...bot,
      preview: String(last?.body ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, PREVIEW_MAX),
      lastAt: session?.summary?.lastAt ?? null,
      unread: Boolean(session?.unread),
      pendingGates: store.pendingGates().filter((gate) => gate.botId === bot.id).length,
    };
  }

  function snapshot() {
    return {
      enabled: enabled(),
      bots: records.map(summary),
      gates: store.pendingGates(),
      grants: store.grants(),
      chats: records.flatMap((bot) => store.chatsFor(bot.id)),
    };
  }
  const changed = () => emit("bots:changed", snapshot());

  /** The bot whose home is `projectPath`, or null. */
  const botOfHome = (projectPath) => records.find((bot) => bot.homePath === projectPath) ?? null;

  /** The bot behind a Chat: its own thread, or a Chat it opened that the user hasn't taken over. */
  function botForChat(chatKey) {
    const thread = records.find((bot) => threadKey(bot) === chatKey);
    if (thread) return { bot: thread, role: "thread" };
    const chat = store.chat(chatKey);
    const bot = chat && chat.status !== "taken-over" ? records.find((record) => record.id === chat.botId) : null;
    return bot ? { bot, role: "chat" } : null;
  }

  // The instructions are a snapshot taken when the thread's agent session starts (home.cjs): a running session keeps
  // the ones it started with, so the provider's prompt cache holds.
  async function refreshInstructions(bot) {
    if (agents.hasSession(threadKey(bot))) return;
    await writeInstructions(bot.homePath, {
      bot,
      brief: await readBrief(bot.homePath),
      memory: (await readMemory(bot.homePath)).text,
      roster: records.map(({ name, role }) => ({ name, role })),
      owner,
    });
  }

  /** A message into the bot's thread, in Bot rules: from the user, or (with `context`) one Milagre writes. */
  async function deliver(bot, body, context) {
    await refreshInstructions(bot);
    return chats.send({
      projectPath: bot.homePath,
      sessionId: bot.threadSessionId,
      body,
      prompt: body,
      images: [],
      files: [],
      provider: bot.provider,
      model: bot.model,
      permissionMode: "bot",
      ...(context ? { context } : {}),
    });
  }

  return {
    owner,
    enabled,
    setEnabled(value) {
      if (typeof value !== "boolean") throw new Error("Bots on or off is a boolean.");
      store.setEnabled(value);
      emit("bots:enabled-changed", { enabled: value });
      changed();
      return { enabled: value };
    },
    snapshot,
    templates: async () => {
      const list = await projects();
      return TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        role: template.role,
        color: template.color,
        body: template.body,
        fields: setupFields(template, { projects: list }),
      }));
    },

    /** Opens every bot's home, so its thread is there for the windows and its interrupted turn continues. */
    async start() {
      for (const bot of records) {
        try {
          await openHome(bot.homePath);
        } catch (error) {
          console.warn(`Milagre couldn't open ${bot.name}'s home:`, error.message);
        }
      }
    },

    async create(input) {
      requireEnabled();
      const template = TEMPLATES.find((item) => item.id === input?.templateId);
      if (!template) throw new Error("Choose a starter bot.");
      const name = cleanName(input.name);
      checkUnique(name);
      if (!PROVIDERS.includes(input.provider)) throw new Error("Choose the agent the bot runs on.");
      if (typeof input.model !== "string" || !input.model) throw new Error("Choose the model the bot runs on.");
      const answers = { ...input.answers, projects: await checkedProjects(input.answers?.projects) };
      const id = botIdFromName(name);
      checkUnique(name);
      creating.add(id);
      try {
        const home = await createBotHome(botsDir, id);
        const { state } = await openHome(home);
        const worktree = Object.values(state.worktrees ?? {}).find((item) => item.path === home);
        if (!worktree) throw new Error(`Milagre couldn't open ${name}'s home.`);
        const threadSessionId = await chats.emptyChat(home, worktree.id);
        await writeBrief(home, renderBrief(template, answers));
        const bot = {
          id,
          name,
          role: template.role,
          color: template.color,
          body: template.body,
          provider: input.provider,
          model: input.model,
          projects: answers.projects,
          paused: false,
          homePath: home,
          homeWorktreeId: worktree.id,
          threadSessionId,
          createdAt: now(),
        };
        store.insertBot(bot);
        refresh();
        changed();
        return bot;
      } finally {
        creating.delete(id);
      }
    },

    /** The profile's edits. The brief lands in BRIEF.md and reaches the bot from its next session. */
    async update(id, patch = {}) {
      requireEnabled();
      const bot = requireBot(id);
      const next = {};
      if (patch.name !== undefined) {
        next.name = cleanName(patch.name);
        checkUnique(next.name, id);
      }
      if (patch.role !== undefined) {
        const role = String(patch.role).replace(/\s+/g, " ").trim();
        if (!role || role.length > ROLE_MAX) throw new Error(`Give the bot a role of up to ${ROLE_MAX} letters.`);
        next.role = role;
      }
      if (patch.paused !== undefined) next.paused = patch.paused === true;
      if (patch.projects !== undefined) next.projects = await checkedProjects(patch.projects);
      if (patch.brief !== undefined) await writeBrief(bot.homePath, String(patch.brief));
      const updated = Object.keys(next).length ? store.updateBot(id, next) : bot;
      refresh();
      changed();
      return updated;
    },

    /** Deletes the bot. Its home goes to <dataDir>/bots/.trash/, so nothing it wrote is lost at once. */
    async remove(id) {
      const bot = requireBot(id);
      await closeHome(bot.homePath);
      store.deleteBot(id);
      refresh();
      try {
        const trash = path.join(path.dirname(bot.homePath), ".trash");
        await fs.mkdir(trash, { recursive: true });
        await fs.rename(bot.homePath, path.join(trash, `${id}-${now()}`));
      } catch (error) {
        console.warn(`Milagre couldn't move ${bot.name}'s home to the trash:`, error.message);
      }
      changed();
    },

    /** The user's message to the bot, in its thread. */
    async send(id, text, context) {
      const bot = requireBot(id);
      requireActive(bot);
      const body = String(text ?? "").trim();
      if (!body) throw new Error("Write a message first.");
      await deliver(bot, body, context);
    },

    /** Before a message the user sends into a bot's thread from a Chat composer (chat:send). */
    async beforeThreadSend(projectPath, sessionId) {
      const bot = botOfHome(projectPath);
      if (!bot) return;
      requireActive(bot);
      if (Number(sessionId) !== bot.threadSessionId) throw new Error(`${bot.name} has one thread. Send your message there.`);
      await refreshInstructions(bot);
    },

    isHome: (projectPath) => botOfHome(projectPath) !== null,
    botForChat,

    readMemory: (id) => readMemory(requireBot(id).homePath),
    saveMemory: async (id, text) => {
      const result = await saveMemoryByVictor(requireBot(id).homePath, text, { now: now() });
      changed();
      return result;
    },

    close() {
      store.close();
    },
  };
}

module.exports = { BOTS_OFF: OFF, createBots };

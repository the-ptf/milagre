const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { BOT_RUNNING_CHAT_CAP, GATE_EXPIRY_MS, botIdFromName } = require("@milagre/shared/bots");
const { PROVIDERS } = require("@milagre/shared/providers");
const { isTurnEnd, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { matchGates } = require("./gates.cjs");
const { createBotTools } = require("./tools.cjs");
const { createBotHome, readBrief, writeBrief, writeInstructions } = require("./home.cjs");
const { readMemory, saveMemoryByUser } = require("./memory.cjs");
const { TEMPLATES, renderBrief, setupFields } = require("./templates.cjs");

// Bots (docs/adr/0010-bots-are-hidden-projects.md): each bot is a hidden Project, its home <dataDir>/bots/<id>/, opened
// by the runtime without entering the registry or the recent list; its thread is one ordinary Chat there. Everything
// else a bot keeps is in angelo.db (store.cjs). The runtime hands this service the few things it needs: opening and
// closing a home, the Chats (`chats.send`, `chats.emptyChat`), the agent sessions and the cached state of a Project.
// A bot opens Milagre Chats for code work through `host`, the Milagre MCP host's Worktree and Chat ports.

const OFF = "Bots are off. Turn them on in Settings › Experimental.";
const NAME_MAX = 40;
const ROLE_MAX = 120;
const PREVIEW_MAX = 120;
const SWEEP_MS = 60_000;
// Answered and expired sign-offs stay in the snapshot this long, so their cards show how they ended.
const GATE_HISTORY_MS = 24 * 60 * 60 * 1000;
const SIGN_OFF_CHOICES = new Set(["once", "always", "deny"]);
const REPLY_MAX = 1000;
const FINISHED = { "turn-completed": "done", "turn-failed": "failed", "turn-cancelled": "failed" };
const OUTCOME = { "turn-completed": "finished", "turn-failed": "failed", "turn-cancelled": "was stopped" };

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
  host,
  // The Project's main branch, where a bot's Chat starts by default.
  mainBranch = async () => "main",
  // What chat_status reports beyond the record: { lastReply, outcome?, branch?, pullRequests, changedFiles, running }.
  chatDetails = async () => null,
  // Whether a Chat runs a turn now or will continue one when its Project opens (see start).
  chatContinues = async () => true,
  titleChat = async () => {},
  emit = () => {},
  now = Date.now,
  // True once Milagre is quitting: what it would tell a bot then could only start a turn the quit cuts off.
  closing = () => false,
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
      gates: store.gatesSince(now() - GATE_HISTORY_MS),
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

  // The folder a Chat's commands run in, for gates that read paths (`rm -r`): Claude's requests don't carry it.
  function cwdOf(chatKey) {
    const state = cachedState(projectOfKey(chatKey));
    const session = state?.sessions?.[sessionIdFromKey(chatKey)];
    return session?.workspacePath ?? state?.worktrees?.[session?.worktree_id]?.path;
  }

  /**
   * The Bot rules answer for a bot's thread or a Chat it opened (permissions.cjs): "allow", unless a gate matches and no
   * grant covers it, then the gate for a sign-off card. It runs on every request, twice for Claude's (its PreToolUse
   * hook and canUseTool), so it records nothing: the card's gate is recorded when it is published (`observe`). A Chat
   * the user took over, or whose bot is gone, gets no answer and asks the user as any Chat does.
   */
  function policyFor(chatKey) {
    if (!botForChat(chatKey)) return undefined;
    return (request) => {
      const owned = botForChat(chatKey);
      if (!owned) return undefined;
      const gates = matchGates({ ...request, cwd: request.cwd ?? cwdOf(chatKey) });
      if (!gates.length) return "allow";
      // A target Milagre can't be sure of is null: no grant covers it, and Always on its card allows once.
      const actions = gates.map(({ kind, title, target, uncoverable }) => ({ kind, title, target: uncoverable ? null : (target ?? projectOfKey(chatKey)) }));
      // One card answers the whole command, so it goes through only when grants cover every gated action in it.
      if (actions.every(({ kind, target }) => target !== null && store.hasGrant(owned.bot.id, kind, target))) return "allow";
      const [first] = actions;
      return {
        gate: {
          kind: first.kind,
          title: actions.length > 1 ? `${first.title} and ${actions.length - 1} more` : first.title,
          command: gates[0].command,
          target: first.target,
          actions,
          botId: owned.bot.id,
          botName: owned.bot.name,
          expiresAt: now() + GATE_EXPIRY_MS,
        },
      };
    };
  }

  // A sign-off's answer reaches the session that asked. One that is gone can't take it: the card expires instead.
  function answer(gate, decision, status) {
    const reached = agents.respondToPermission(gate.chatKey, gate.requestId, decision);
    store.setGateStatus(gate.chatKey, gate.requestId, reached ? status : "expired");
  }

  /** Ends the sign-offs whose hour is up: each is denied, shows Expired, and its bot is told it may ask again. */
  async function sweep(at = now()) {
    const expired = store.expiredGates(at);
    for (const gate of expired) {
      store.setGateStatus(gate.chatKey, gate.requestId, "expired");
      agents.respondToPermission(gate.chatKey, gate.requestId, "deny");
    }
    if (expired.length) changed();
    for (const gate of expired)
      await notify(
        gate.botId,
        `Sign-off for ${gate.meta.title} expired. ${owner} didn't answer within an hour, so it counts as denied. Ask again if it's still needed.`,
        { kind: "bot-gate-expired", requestId: gate.requestId, chatKey: gate.chatKey },
      );
  }
  let sweeper = null;

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

  // What Milagre tells a bot (a sign-off expired, a Chat finished) starts a turn in its thread, unless the bot can't
  // take one now: paused, deleted, Bots switched off, or Milagre quitting.
  async function notify(botId, body, context) {
    const bot = records.find((record) => record.id === botId);
    if (!bot || bot.paused || !enabled() || closing()) return;
    await deliver(bot, body, context).catch((error) => console.warn(`Milagre couldn't reach ${bot.name}:`, error.message));
  }

  const nameOf = (projectPath) => path.basename(projectPath) || projectPath;
  function requireOwnChat(bot, chatKey) {
    const chat = store.chat(String(chatKey ?? ""));
    if (!chat || chat.botId !== bot.id) throw new Error(`${bot.name} didn't open that Chat. chat_list_mine lists the ones it did.`);
    if (chat.status === "taken-over") throw new Error(`${owner} took over this Chat.`);
    return chat;
  }
  // A Chat Milagre starts or steers for a bot: the bot's provider and model, under its gates.
  const sendToChat = (bot, chatKey, text, operationId) =>
    chats.send({
      projectPath: projectOfKey(chatKey),
      sessionId: sessionIdFromKey(chatKey),
      body: text,
      prompt: text,
      images: [],
      files: [],
      provider: bot.provider,
      model: bot.model,
      permissionMode: "bot",
      context: { kind: "bot-message", botId: bot.id, botName: bot.name },
      ...(operationId ? { operationId } : {}),
    });

  // Chats a bot is opening now, by bot id: they hold a slot of the cap before their record exists.
  const opening = new Map();
  function requireRoom(bot) {
    const running = store.chatsFor(bot.id).filter((chat) => chat.status === "running").length + (opening.get(bot.id) ?? 0);
    if (running >= BOT_RUNNING_CHAT_CAP) throw new Error(`${bot.name} already has ${BOT_RUNNING_CHAT_CAP} Chats running. Wait for one to finish or close one.`);
  }

  /** chat_open: a new Worktree from `base` (the main branch) in one of the bot's Projects, and a Chat started there. */
  async function chatOpen(botId, { project, title, prompt, base } = {}) {
    const bot = requireBot(botId);
    requireActive(bot);
    const projectPath = bot.projects.find((item) => item === project || nameOf(item) === project);
    if (!projectPath) throw new Error(`${bot.name} may open Chats only in: ${bot.projects.map(nameOf).join(", ")}.`);
    const name = String(title ?? "").trim();
    const text = String(prompt ?? "").trim();
    if (!name || !text) throw new Error("A Chat needs a title and a prompt.");
    requireRoom(bot);
    // The slot is taken before the first await, so chat_open calls made at once can't all pass the cap.
    opening.set(bot.id, (opening.get(bot.id) ?? 0) + 1);
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      opening.set(bot.id, opening.get(bot.id) - 1);
    };
    try {
      const operationId = `bot:${bot.id}:${randomUUID()}`;
      const assertActive = () => requireActive(requireBot(bot.id));
      const baseBranch = typeof base === "string" && base.trim() ? base.trim() : await mainBranch(projectPath);
      const { worktreeId } = await host.createWorktree({ projectPath, baseBranch, prompt: text }, operationId, assertActive);
      const { chatId } = await host.createChat({ projectPath, worktreeId }, operationId, assertActive);
      // From here its record holds the slot.
      store.linkChat({ chatKey: chatId, botId: bot.id, title: name, projectPath, status: "running", createdAt: now() });
      release();
      changed();
      await titleChat(chatId, name);
      await sendToChat(bot, chatId, text, operationId);
      return { chatKey: chatId, title: name, project: nameOf(projectPath), baseBranch };
    } finally {
      release();
    }
  }

  /** chat_status: one Chat the bot opened, as it stands now. */
  async function chatStatus(botId, chatKey) {
    const bot = requireBot(botId);
    const chat = store.chat(String(chatKey ?? ""));
    if (!chat || chat.botId !== bot.id) throw new Error(`${bot.name} didn't open that Chat. chat_list_mine lists the ones it did.`);
    const details = (await chatDetails(chat.chatKey)) ?? {};
    const pending = store.pendingGates().filter((gate) => gate.chatKey === chat.chatKey);
    return {
      ...chat,
      project: nameOf(chat.projectPath),
      ...details,
      lastReply: String(details.lastReply ?? "").slice(0, REPLY_MAX),
      waitingForSignOff: pending.map((gate) => gate.meta.title),
    };
  }

  /** chat_send: steers or continues a Chat the bot opened, until the user takes it over. */
  async function chatSend(botId, chatKey, text) {
    const bot = requireBot(botId);
    const chat = requireOwnChat(bot, chatKey);
    requireActive(bot);
    const body = String(text ?? "").trim();
    if (!body) throw new Error("Write a message first.");
    if (chat.status !== "running") {
      // Continuing a finished Chat runs it again: it needs a slot of the cap.
      requireRoom(bot);
      store.setChatStatus(chat.chatKey, "running");
      changed();
    }
    await sendToChat(bot, chat.chatKey, body);
  }

  /**
   * The user sent a message in a Chat a bot opened: it is theirs now. Bot rules and the bot's grants stop there (its
   * policy no longer answers), and the bot is told.
   */
  async function takeOver(chatKey) {
    const chat = store.chat(chatKey);
    if (!chat || chat.status === "taken-over") return;
    store.setChatStatus(chatKey, "taken-over");
    changed();
    await notify(chat.botId, `${owner} took over this Chat: ${chat.title} (${chatKey}). Don't steer it any more.`, {
      kind: "bot-chat-taken-over",
      chatKey,
    });
  }

  // A turn ended in a Chat a bot opened: the bot's thread gets a turn to act on it, like a Delegation report.
  async function chatFinished(chat, event) {
    store.setChatStatus(chat.chatKey, FINISHED[event.type]);
    changed();
    const details = (await chatDetails(chat.chatKey).catch(() => null)) ?? {};
    const reply = String(details.lastReply ?? "").trim();
    const body = [
      `Chat ${OUTCOME[event.type]}: ${chat.title} (${chat.chatKey}, in ${nameOf(chat.projectPath)}).`,
      reply ? `Its last reply:\n\n${reply.slice(0, REPLY_MAX)}${reply.length > REPLY_MAX ? "…" : ""}` : "It ended without a reply.",
    ].join("\n\n");
    await notify(chat.botId, body, { kind: "bot-chat-finished", chatKey: chat.chatKey, status: FINISHED[event.type] });
  }

  const tools = createBotTools({
    now,
    bots: {
      chatOpen,
      chatStatus,
      chatSend,
      chatsMine: (botId) => store.chatsFor(botId),
    },
  });

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

    /**
     * Opens every bot's home, so its thread is there for the windows and its interrupted turn continues. A sign-off
     * still pending from before a restart can't be answered any more (its session is gone): it expires now. A Chat a
     * bot opened that runs no turn and won't continue one (a crash, or a quit too long ago) is failed, quietly: it would
     * otherwise run forever and hold a slot of the cap.
     */
    async start() {
      const stale = store.pendingGates();
      for (const gate of stale) store.setGateStatus(gate.chatKey, gate.requestId, "expired");
      if (stale.length) changed();
      // Every minute, on or off: the Chats a bot opened keep their gates when Bots is switched off.
      sweeper ??= setInterval(() => void sweep().catch((error) => console.warn("Milagre couldn't expire sign-offs:", error.message)), SWEEP_MS);
      sweeper.unref?.();
      for (const bot of records) {
        try {
          await openHome(bot.homePath);
        } catch (error) {
          console.warn(`Milagre couldn't open ${bot.name}'s home:`, error.message);
        }
      }
      let stopped = false;
      for (const chat of records.flatMap((bot) => store.chatsFor(bot.id)))
        if (chat.status === "running" && !(await chatContinues(chat.chatKey).catch(() => true))) {
          store.setChatStatus(chat.chatKey, "failed");
          stopped = true;
        }
      if (stopped) changed();
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

    /**
     * Deletes the bot. The Chats it opened stay in Milagre as the user's, and nothing waits on its sign-offs any more:
     * they are denied. Its home goes to <dataDir>/bots/.trash/, so nothing it wrote is lost at once.
     */
    async remove(id) {
      const bot = requireBot(id);
      for (const chat of store.chatsFor(id)) if (chat.status !== "taken-over") store.setChatStatus(chat.chatKey, "taken-over");
      for (const gate of store.pendingGates().filter((item) => item.botId === id)) {
        store.setGateStatus(gate.chatKey, gate.requestId, "denied");
        agents.respondToPermission(gate.chatKey, gate.requestId, "deny");
      }
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
    /** False for the home of a bot that can't take a turn now (paused, or Bots off): its interrupted turn waits. */
    takesTurns(projectPath) {
      const bot = botOfHome(projectPath);
      return !bot || (enabled() && !bot.paused);
    },
    botForChat,
    policyFor,
    sweep,
    chatOpen,
    chatStatus,
    chatSend,
    chatsMine: (botId) => store.chatsFor(requireBot(botId).id),
    takeOver,
    /** Milagre's tools for a bot's thread session: its memory and the Chats it opens. Other Chats get none. */
    toolsFor(chatKey) {
      const owned = botForChat(chatKey);
      return owned?.role === "thread" ? tools.definitions(chatKey, owned.bot) : [];
    },

    /** Follows the agent events of every Chat: the sign-off cards bots' sessions publish and how they end. */
    async observe(chatKey, event) {
      if (event.type === "permission-request" && event.gate) {
        if (!botForChat(chatKey) || !records.some((bot) => bot.id === event.gate.botId)) return;
        store.recordGate({ requestId: event.requestId, botId: event.gate.botId, chatKey, meta: event.gate, status: "pending", createdAt: now() });
        changed();
        return;
      }
      if (event.type === "permission-resolved") {
        const gate = store.gate(chatKey, event.requestId);
        // Answered here first, or expired: the card already says how it ended.
        if (!gate || gate.status !== "pending") return;
        store.setGateStatus(chatKey, event.requestId, event.decision === "allow" || event.decision === "allow-for-chat" ? "allowed" : "denied");
        changed();
        return;
      }
      // A turn starting in a Chat a bot opened that was ended (a resume that raced start's check) runs it again.
      if (event.type === "turn-started") {
        const chat = store.chat(chatKey);
        if (chat && (chat.status === "done" || chat.status === "failed") && records.some((bot) => bot.id === chat.botId)) {
          store.setChatStatus(chatKey, "running");
          changed();
        }
        return;
      }
      if (isTurnEnd(event)) {
        // A turn a quit stopped continues when Milagre starts again (chats.resumeInterrupted): its Chat still runs.
        if (event.type === "turn-cancelled" && event.quit) return;
        const chat = store.chat(chatKey);
        if (chat?.status === "running" && records.some((bot) => bot.id === chat.botId)) await chatFinished(chat, event);
        else if (records.some((bot) => threadKey(bot) === chatKey)) changed();
      }
    },

    /** The user's sign-off on the card `requestId` in Chat `chatKey`. A card answered or expired already stays as it is. */
    async answerGate(chatKey, requestId, choice) {
      if (!SIGN_OFF_CHOICES.has(choice)) throw new Error(`Unknown sign-off: ${choice}`);
      const gate = store.gate(String(chatKey), String(requestId));
      if (!gate) throw new Error("That sign-off is no longer there.");
      if (gate.status !== "pending") return gate;
      if (gate.meta.expiresAt <= now()) {
        await sweep();
        return store.gate(gate.chatKey, gate.requestId);
      }
      if (choice === "always")
        for (const { kind, target } of gate.meta.actions ?? [gate.meta])
          if (target && !store.hasGrant(gate.botId, kind, target)) store.addGrant({ botId: gate.botId, gate: kind, target, createdAt: now() });
      answer(gate, choice === "deny" ? "deny" : "allow", choice === "deny" ? "denied" : "allowed");
      changed();
      return store.gate(gate.chatKey, gate.requestId);
    },

    /** Revoke on a grant: that gate asks again from the next request. */
    async revokeGrant(id) {
      store.revokeGrant(String(id), now());
      changed();
    },

    /** BRIEF.md, as the profile shows it. */
    readBrief: async (id) => ({ text: await readBrief(requireBot(id).homePath) }),
    readMemory: (id) => readMemory(requireBot(id).homePath),
    saveMemory: async (id, text) => {
      const result = await saveMemoryByUser(requireBot(id).homePath, text, { now: now() });
      changed();
      return result;
    },

    close() {
      clearInterval(sweeper);
      store.close();
    },
  };
}

module.exports = { BOTS_OFF: OFF, createBots };

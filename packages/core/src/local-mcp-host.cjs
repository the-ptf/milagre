const crypto = require("node:crypto");
const { realpathSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { projectOfKey, sessionIdFromKey, lastUserModel } = require("@milagre/shared/agent-runs");
const { IMAGE_TYPES } = require("@milagre/shared/limits");
const { chatActivity } = require("@milagre/shared/chat-activity");
const { queueStatus } = require("@milagre/shared/queued-messages");
const { providerCapabilities } = require("@milagre/shared/provider-capabilities");
// A tool never gives a Chat more than its caller has without the user's say.
const { callerMode: asCaller, raisesMode } = require("./agents/permissions.cjs");
const { inspectProject } = require("./project-identity.cjs");
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** The answers as the Chat shows them in the user's message, as the question card writes them. */
function answerSummary(questions, answers) {
  const shown = (question) =>
    (answers[question.id] ?? []).map((value) => (question.secret && !question.options.some((option) => option.label === value) ? "••••••" : value)).join(", ");
  if (questions.length === 1) return shown(questions[0]);
  return questions.map((question, index) => `${question.header || `Question ${index + 1}`}: ${shown(question)}`).join("\n");
}

/** What the receiving agent is told about who sent a chat_start message, which arrives as a plain user turn. */
function senderLine(from, client) {
  if (from) return `Message from the agent of Chat ${from}, sent with Milagre's chat_start (not the user):`;
  return `Message sent by ${client || "an outside client"} through Milagre's MCP (not the user):`;
}

/** `body` with the attached files listed, as the composer sends it. */
function attachmentPrompt(body, files) {
  return files.length ? `${body}\n\nAttached files:\n${files.join("\n")}` : body;
}

// Narrow host ports; no caller-supplied method names or command payload forwarding.
/**
 * Ports beyond reads: stopChat(chatId), setPermissionMode(chatId, mode), respondPermission(chatId, requestId, decision),
 * answerQuestion(chatId, requestId, answers, summary), patchChat(projectPath, sessionId, patch),
 * searchChats(projectPath, query, limit), links: { list(), add(a, b), remove(id) }, activeWorktrees(projectPath) -> paths,
 * models(projectPath) -> { [provider]: [{ id, efforts, defaultEffort }] }, the pickers' catalog,
 * worktreeStatus(path, base) -> { uncommitted, unpushed, branch, removable } (worktree-cleanup.cjs),
 * removeWorktree(projectPath, worktreePath) -> { removed, branch, branchDeleted }, the safe removal only,
 * approve(callerChat, request) -> "allow" | "allow-for-chat" | "deny" | "cancelled",
 * botOf(chatId) -> the name of the bot that runs a Chat (its thread, or a Chat it opened the user hasn't taken over).
 * `caller` is the Chat whose agent called the tool; an outside client has none and counts as an Ask caller with nowhere
 * to show an approval card. A caller in Bot rules counts as an Ask caller too.
 */
function createLocalMcpHost({
  projects,
  readProject,
  scopeStates,
  chats,
  createWorktree,
  validateDesignChat,
  permissionMode,
  stopChat,
  setPermissionMode,
  respondPermission,
  answerQuestion,
  patchChat,
  searchChats,
  links,
  activeWorktrees,
  approve,
  models = async () => ({}),
  getProjectAccounts,
  assignProjectAccount,
  worktreeStatus,
  removeWorktree,
  registerProject = async () => {
    throw Error("Adding Projects is unavailable");
  },
  assertRegistrableProject = async () => {},
  botOf = () => null,
}) {
  const validateProject = async (projectPath) => {
    if (!(await projects()).some((project) => project.path === projectPath) || realpathSync(projectPath) !== projectPath)
      throw Error("Project is outside scope until opened in Milagre (or registered with project_add); its canonical path is required");
  };
  const project = async (projectPath) => {
    await validateProject(projectPath);
    return (await readProject(projectPath)).state;
  };
  const chat = async (projectPath, chatId) => {
    if (projectOfKey(chatId) !== projectPath || !Number.isSafeInteger(sessionIdFromKey(chatId))) throw Error("Chat is outside this Project's scope");
    const state = await project(projectPath);
    const session = state.sessions[sessionIdFromKey(chatId)];
    if (!session) throw Error("Chat is unavailable");
    return { state, session };
  };
  const progress = (chatId, session) => {
    const run = chats.runs[chatId];
    // A turn's end isn't the end of the Chat's work while background agents still run (chat-activity.mjs).
    const { activity, background } = chatActivity(session, run);
    return {
      chatId,
      id: session.id,
      worktreeId: session.worktree_id,
      title: session.title || session.generatedTitle || "Chat",
      archived: Boolean(session.archived),
      provider: session.provider,
      status: run ? "running" : session.status,
      activity,
      backgroundWork: background,
      approvals: run?.approvals?.length ?? 0,
      questions: run?.questions?.length ?? 0,
      queued: session.queued?.length ?? 0,
    };
  };
  // Messages waiting for the running turn to end, on a provider that can't steer (chat-host.cjs), with the line the
  // Chat shows above them.
  const queue = (chatId, session) =>
    session.queued?.length
      ? {
          queue: {
            status: queueStatus({ count: session.queued.length, held: Boolean(session.queueHeld), running: Boolean(chats.runs[chatId]) }),
            messages: session.queued.map(({ id, body, provider, model, queuedAt }) => ({ id, body, provider, model, queuedAt })),
          },
        }
      : {};
  const callerMode = (caller) => (caller ? asCaller(permissionMode(caller, "ask")) : "ask");
  // A bot's Chat runs under its gates and only the bot steers it, until the user takes it over in Milagre: no other Chat
  // or outside client starts, stops, switches, answers for or renames it.
  const notBots = (chatId) => {
    const bot = botOf(chatId);
    if (bot) throw Error(`${bot} runs this Chat; open it in Milagre to take it over.`);
  };
  // Past what the caller may do alone: the user decides on a card in the caller's Chat. An outside client has no Chat.
  const confirm = async (caller, request) => {
    if (!caller) throw Error(`${request.title.replace(/\?$/, "")} needs approval in Milagre, which an outside client can't ask for. Do it in Milagre instead.`);
    const decision = await approve(caller, { requestId: `mcp-${crypto.randomUUID()}`, kind: "other", tool: "Milagre", allowForChat: false, ...request });
    if (decision !== "allow" && decision !== "allow-for-chat") throw Error("The user declined.");
  };
  // `prompt`, for chat_start: what would run there. Without `asked` the Chat already runs in `mode`, above the caller's.
  const checkMode = async (caller, chatId, mode, session, { prompt, asked = true } = {}) => {
    if (!raisesMode(mode, callerMode(caller))) return;
    const name = session?.title || session?.generatedTitle;
    const chatName = name ? `"${name}"` : "another Chat";
    const modeName = mode === "full" ? "Full permission" : mode === "auto" ? "Auto mode" : "Bot rules";
    await confirm(caller, {
      ...(asked
        ? { title: `Run ${chatName} in ${modeName}?`, description: "This Chat's agent asks to give it more permission than it has itself." }
        : {
            title: `Run a prompt in ${chatName} in ${modeName}?`,
            description: `That Chat runs in ${modeName}, more than this Chat's agent has, and the prompt would run there with it.`,
          }),
      ...(prompt ? { detail: JSON.stringify({ permissionMode: mode, prompt }, null, 2) } : {}),
    });
  };
  // "Project / branch / title (ref)": how the receiving agent can tell which Chat sent it, and reach it again.
  const callerLabel = async (caller) => {
    try {
      const { state, session } = await chat(projectOfKey(caller), caller);
      const branch = state.worktrees?.[session.worktree_id]?.name ?? "unknown branch";
      return `${path.basename(projectOfKey(caller))} / ${branch} / ${session.title || session.generatedTitle || "Chat"} (${caller})`;
    } catch {
      return caller;
    }
  };
  const runOf = (chatId) => chats.runs[chatId];
  const pending = (chatId) => {
    const run = runOf(chatId);
    return {
      approvals: (run?.approvals ?? []).map(({ requestId, kind, tool, title, description, command, cwd, files, reason }) => ({
        requestId,
        kind,
        tool,
        title,
        ...(description ? { description } : {}),
        ...(command ? { command } : {}),
        ...(cwd ? { cwd } : {}),
        ...(files?.length ? { files } : {}),
        ...(reason ? { reason } : {}),
      })),
      questions: run?.questions ?? [],
    };
  };
  // A path the caller names for an attachment: inside the Chat's own Worktree, so a file elsewhere on the Mac can't ride along.
  const attachment = async (root, file) => {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw Error("Attach files by absolute path inside the Chat's Worktree.");
    const real = await fs.realpath(file).catch(() => {
      throw Error(`No such file: ${file}`);
    });
    const from = path.relative(await fs.realpath(root), real);
    if (!from || from.startsWith("..") || path.isAbsolute(from)) throw Error(`${file} is outside the Chat's Worktree.`);
    return real;
  };
  const endpoint = async (projectPath, worktreeId) => {
    const state = await project(projectPath);
    const worktree = worktreeId === undefined ? Object.values(state.worktrees).find((item) => item.path === projectPath) : state.worktrees[worktreeId];
    if (!worktree)
      throw Error(worktreeId === undefined ? `No main Worktree in ${projectPath}; pass targetWorktreeId` : `Worktree ${worktreeId} isn't in ${projectPath}`);
    if (!(await activeWorktrees(projectPath)).includes(worktree.path)) throw Error("That Worktree is archived or gone.");
    const registered = (await projects()).find((item) => item.path === projectPath);
    return { project_id: registered.id, worktree_path: worktree.path };
  };
  const sameEnd = (a, b) => a.project_id === b.project_id && a.worktree_path === b.worktree_path;
  const scopeRequests = new Map();
  const requestProjectScope = async (caller, projectPath, onGrant) => {
    if (!caller) throw Error("Project is outside this connection's scope. Grant access to it (or select All Projects) in Milagre Settings > Milagre.");
    notBots(caller);
    await validateProject(projectPath);
    if (callerMode(caller) === "full") return;
    const key = `${caller}\0${projectPath}`;
    let running = scopeRequests.get(key);
    if (!running) {
      running = (async () => {
        const registered = (await projects()).find((item) => item.path === projectPath);
        const name = registered?.name || path.basename(projectPath);
        const decision = await approve(caller, {
          requestId: `mcp-${crypto.randomUUID()}`,
          kind: "other",
          tool: "Milagre",
          allowForChat: true,
          title: `Allow this Chat to access "${name}"?`,
          description: "Its agent could inspect and manage Worktrees and Chats in that Project.",
          detail: JSON.stringify({ projectPath }, null, 2),
        });
        if (decision === "allow-for-chat") onGrant?.(projectPath);
        if (decision === "cancelled") throw Error("The approval card closed before the user answered.");
        if (decision !== "allow" && decision !== "allow-for-chat")
          throw Error(
            "The user declined access to that Project. Link the Projects on the canvas or with worktree_link if cross-Project collaboration is needed.",
          );
      })().finally(() => {
        if (scopeRequests.get(key) === running) scopeRequests.delete(key);
      });
      scopeRequests.set(key, running);
    }
    return running;
  };
  return {
    projects,
    validateProject,
    async projectAccounts({ projectPath, refresh }) {
      await validateProject(projectPath);
      return getProjectAccounts(projectPath, refresh);
    },
    async setProjectAccount({ projectPath, provider, accountId }, assertActive) {
      await validateProject(projectPath);
      assertActive();
      return assignProjectAccount(projectPath, provider, accountId, () => {
        assertActive();
        return true;
      });
    },
    requestProjectScope,
    validateChat: validateDesignChat,
    async addProject({ projectPath }, caller, inScope = () => false, onGrant) {
      if (caller) notBots(caller);
      const { identity } = await inspectProject(projectPath).catch((error) => {
        if (error?.code === "ENOENT") throw Error(`No such folder: ${projectPath}`);
        throw error;
      });
      if (!identity.git) throw Error(`${identity.path} isn't a Git repository. Initialize Git there before registering it with project_add.`);
      await assertRegistrableProject(identity.path);
      const existing = (await projects()).find((item) => item.path === identity.path);
      if (existing) {
        const name = existing.name || identity.name;
        if (!inScope(identity.path)) {
          if (!caller)
            throw Error(
              "Project is already registered in Milagre, and outside this connection's scope. Grant access to it (or select All Projects) in Milagre Settings > Milagre.",
            );
          if (callerMode(caller) !== "full")
            await confirm(caller, {
              title: `Grant this Chat access to "${name}"?`,
              description: "Project is already in Milagre. Grants this Chat access to inspect and manage its Worktrees and Chats.",
              detail: JSON.stringify({ projectPath: identity.path }, null, 2),
            });
          onGrant?.(identity.path);
        }
        return { id: existing.id, path: existing.path, name, created: false, ...(caller ? { inScope: true } : {}) };
      }
      if (!caller || callerMode(caller) !== "full")
        await confirm(caller, {
          title: `Add Project "${identity.name}" to Milagre?`,
          description: "Registers this repository in Milagre and lets this Chat inspect and manage its Worktrees and Chats.",
          detail: JSON.stringify({ projectPath: identity.path }, null, 2),
        });
      await registerProject(identity.path);
      if (caller) onGrant?.(identity.path);
      const added = (await projects()).find((item) => item.path === identity.path);
      return { id: added?.id ?? identity.id, path: identity.path, name: added?.name ?? identity.name, created: true, ...(caller ? { inScope: true } : {}) };
    },
    async worktrees(projectPath) {
      return Object.values((await project(projectPath)).worktrees).map(({ id, name, path, base }) => ({ id, name, path, base }));
    },
    async chats({ projectPath, worktreeId }) {
      return Object.values((await project(projectPath)).sessions)
        .filter((session) => worktreeId === undefined || session.worktree_id === worktreeId)
        .map((session) => progress(`${projectPath}#${session.id}`, session));
    },
    async readChat({ projectPath, chatId, limit }) {
      const { session } = await chat(projectPath, chatId);
      const messages = await scopeStates.chatMessages(projectPath, [session.id]);
      return {
        ...progress(chatId, session),
        ...pending(chatId),
        ...queue(chatId, session),
        messages: messages.slice(-limit).map(({ id, role, body }) => ({ id, role, body })),
      };
    },
    async createWorktree(args, operationId, assertActive) {
      const result = await createWorktree({ localMcp: { operationId, assertActive } }, args);
      return { projectPath: args.projectPath, worktreeId: result.worktreeId, ...(result.setupNote ? { setupNote: result.setupNote } : {}) };
    },
    async createChat({ projectPath, worktreeId }, operationId, assertActive) {
      await project(projectPath);
      assertActive();
      const id = await chats.emptyChat(projectPath, worktreeId, { operationId, assertActive });
      return { chatId: `${projectPath}#${id}` };
    },
    // A Chat with no live agent takes the mode of the Chat whose agent called the tool; other clients start it in Ask.
    // A provider, model or effort named here switches the Chat as the composer's pickers do; a new provider hands off.
    async startChat(
      { projectPath, chatId, prompt, provider, model, effort, permissionMode: asked, files = [], images = [] },
      operationId,
      assertActive,
      caller,
      client,
    ) {
      const { state, session } = await chat(projectPath, chatId);
      notBots(chatId);
      if (session.archived) throw Error("This Chat is archived");
      const latest = chats.turnSettings(chatId) ?? {};
      const messages = await scopeStates.chatMessages(projectPath, [session.id]);
      const chosenModel = model || latest.model || lastUserModel({ ...state, messages }, session.id);
      if (!chosenModel) throw Error("Choose a model for this Chat before starting it");
      const chosenProvider = provider || latest.provider || session.provider || "claude";
      // The effort the pickers would allow: one named here must fit the model; a carried one falls back to its default.
      const entry = ((await models(projectPath))[chosenProvider] ?? []).find((item) => item.id === chosenModel);
      if (effort && entry && !entry.efforts.includes(effort)) throw Error(`${chosenModel} takes effort ${entry.efforts.join(", ") || "none"}, not ${effort}.`);
      const chosenEffort = effort ?? (entry && latest.effort && !entry.efforts.includes(latest.effort) ? entry.defaultEffort : latest.effort);
      // The prompt runs in the asked mode, else the Chat's own (a Chat with no live agent takes the caller's): either way,
      // more than the caller has needs the user's say first.
      const modeNow = () => asked ?? permissionMode(chatId, callerMode(caller));
      const mode = modeNow();
      await checkMode(caller, chatId, mode, session, { prompt, asked: Boolean(asked) });
      const root = session.workspacePath ?? state.worktrees?.[session.worktree_id]?.path;
      if ((files.length || images.length) && !root) throw Error("This Chat has no Worktree to attach files from.");
      const attached = await Promise.all(files.map((file) => attachment(root, file)));
      const pictures = await Promise.all(
        images.map(async (file, index) => {
          const real = await attachment(root, file);
          const mime = IMAGE_MIME[path.extname(real).toLowerCase()];
          if (!mime || !IMAGE_TYPES.includes(mime)) throw Error(`${file} isn't a PNG, JPEG, GIF or WebP image.`);
          return { id: `mcp-${index}`, name: path.basename(real), dataUrl: `data:${mime};base64,${(await fs.readFile(real)).toString("base64")}`, path: real };
        }),
      );
      assertActive();
      const waits = Boolean(chats.runs?.[chatId]) && !providerCapabilities(session.provider ?? chosenProvider).steer;
      const result = await chats.send({
        ...latest,
        projectPath,
        sessionId: session.id,
        // The Chat shows `body` as the user's message; the agent is told who really sent it.
        body: prompt,
        prompt: `${senderLine(caller && (await callerLabel(caller)), client)}\n\n${attachmentPrompt(prompt, attached)}`,
        images: pictures,
        files: attached,
        provider: chosenProvider,
        model: chosenModel,
        effort: chosenEffort,
        permissionMode: mode,
        operationId,
        canStart: () => {
          assertActive();
          if (modeNow() !== mode) throw Error("Chat permission mode changed; inspect the Chat before retrying");
          return true;
        },
      });
      // A running turn takes the asked mode at once, as the composer's switch does.
      if (asked) await setPermissionMode(chatId, asked);
      // A provider that can't steer keeps this message in the durable Chat queue, so the caller hears it waits.
      return {
        chatId: `${projectPath}#${result.sessionId}`,
        accepted: true,
        ...(waits ? { note: "This Chat's agent can't take a message mid-turn: it starts this one after its running turn ends." } : {}),
      };
    },
    async stopChat({ projectPath, chatId }) {
      await chat(projectPath, chatId);
      notBots(chatId);
      const running = Boolean(runOf(chatId));
      await stopChat(chatId);
      return { chatId, stopped: running };
    },
    async setMode({ projectPath, chatId, permissionMode: mode }, caller) {
      const { session } = await chat(projectPath, chatId);
      notBots(chatId);
      if (!runOf(chatId) && permissionMode(chatId, null) === null)
        throw Error("This Chat has no running agent. Pass permissionMode to chat_start to start it in that mode.");
      await checkMode(caller, chatId, mode, session);
      await setPermissionMode(chatId, mode);
      return { chatId, permissionMode: mode };
    },
    // Answering another Chat's approval is a decision the user makes, unless the caller runs in Full permission itself.
    async respond({ projectPath, chatId, requestId, decision, answers }, caller) {
      const { session } = await chat(projectPath, chatId);
      notBots(chatId);
      if (caller === chatId) throw Error("A Chat can't answer its own approvals or questions.");
      const { approvals, questions } = pending(chatId);
      const approval = approvals.find((item) => item.requestId === requestId);
      const question = questions.find((item) => item.requestId === requestId);
      if (!approval && !question) throw Error("Nothing with that requestId is waiting in this Chat. chat_read lists what is.");
      const asking = `"${session.title || session.generatedTitle || "Another Chat"}"`;
      if (approval) {
        if (!decision) throw Error("Give a decision: allow, allow-for-chat or deny.");
        // The card shows what the other Chat would do, in the fields its own card uses.
        if (decision !== "deny" && callerMode(caller) !== "full")
          await confirm(caller, {
            title: decision === "allow-for-chat" ? `Always allow this in ${asking}?` : `Allow this in ${asking}?`,
            description: `That Chat asks: ${approval.title.replace(/\?$/, "")}. This Chat's agent wants to answer for you.`,
            ...(approval.command ? { command: approval.command } : {}),
            ...(approval.cwd ? { cwd: approval.cwd } : {}),
            ...(approval.files ? { files: approval.files } : {}),
            ...(approval.reason ? { reason: approval.reason } : {}),
            ...(!approval.command && !approval.files ? { detail: JSON.stringify(approval, null, 2) } : {}),
          });
        return { chatId, requestId, accepted: Boolean(await respondPermission(chatId, requestId, decision)) };
      }
      if (answers === undefined) throw Error("Give answers: the picked labels or typed text per question id, or null to dismiss.");
      const summary = answers ? answerSummary(question.questions, answers) : undefined;
      if (answers && callerMode(caller) !== "full")
        await confirm(caller, {
          title: `Answer ${asking}'s questions?`,
          description: "This Chat's agent wants to answer them for you.",
          reason: summary,
        });
      return { chatId, requestId, accepted: Boolean(await answerQuestion(chatId, requestId, answers, summary)) };
    },
    async updateChat({ projectPath, chatId, title, archived }) {
      const { session } = await chat(projectPath, chatId);
      notBots(chatId);
      if (title === undefined && archived === undefined) throw Error("Give a title, archived, or both.");
      if (archived && runOf(chatId)) throw Error("Stop the Chat before archiving it.");
      await patchChat(projectPath, session.id, { ...(title !== undefined ? { title: title.trim() } : {}), ...(archived !== undefined ? { archived } : {}) });
      return { chatId, ...(title !== undefined ? { title: title.trim() } : {}), ...(archived !== undefined ? { archived } : {}) };
    },
    async searchChats({ projectPath, query, limit }) {
      const state = await project(projectPath);
      const matches = await searchChats(projectPath, query, limit);
      return matches.map(({ message, snippet }) => ({
        chatId: `${projectPath}#${message.session_id}`,
        title: state.sessions[message.session_id]?.title || state.sessions[message.session_id]?.generatedTitle || "Chat",
        messageId: message.id,
        snippet,
      }));
    },
    // A Link reaches the other Worktree's files, git and Chats. From an agent in Ask mode the user approves it first.
    async linkWorktrees({ projectPath, worktreeId, targetProjectPath, targetWorktreeId }, caller, inScope) {
      if (!inScope(targetProjectPath) && !caller) throw Error("The target Project is outside this connection's scope");
      await validateProject(targetProjectPath);
      const a = await endpoint(projectPath, worktreeId);
      const b = await endpoint(targetProjectPath, targetWorktreeId);
      const existing = (await links.list()).find((link) => [link.a, link.b].some((end) => sameEnd(end, a)) && [link.a, link.b].some((end) => sameEnd(end, b)));
      if (existing) return { linkId: existing.id, created: false };
      if (callerMode(caller) === "ask" && caller)
        await confirm(caller, {
          title: "Link this Worktree to another?",
          description: "Its agent could read the other Worktree's files, git and Chats, and send it Delegations.",
          detail: JSON.stringify({ from: a.worktree_path, to: b.worktree_path }, null, 2),
        });
      const before = new Set((await links.list()).map((link) => link.id));
      const added = (await links.add(a, b)).find((link) => !before.has(link.id));
      return { linkId: added?.id, created: true };
    },
    // Only a Worktree-to-Worktree Link that has this Worktree at one end: Project Links stay the canvas's.
    async unlinkWorktrees({ projectPath, worktreeId, targetWorktreePath }) {
      const worktree = (await project(projectPath)).worktrees[worktreeId];
      if (!worktree) throw Error(`Worktree ${worktreeId} isn't in ${projectPath}`);
      const removable = (await links.list()).filter(
        (link) =>
          link.a.worktree_path !== undefined &&
          link.b.worktree_path !== undefined &&
          [link.a, link.b].some((end) => end.worktree_path === worktree.path) &&
          [link.a, link.b].some((end) => end.worktree_path === targetWorktreePath),
      );
      if (!removable.length) throw Error("No Worktree Link joins these two. Project Links are removed on the canvas.");
      for (const link of removable) await links.remove(link.id);
      return { removed: removable.map((link) => link.id) };
    },
    // Only the safe removal (worktree-cleanup.cjs): a Worktree with uncommitted files, or commits on neither its base
    // nor its upstream, is kept, so nothing is lost but the checkout and the Chats the caller archived.
    async removeWorktree({ projectPath, worktreeId }, caller) {
      const state = await project(projectPath);
      const worktree = state.worktrees[worktreeId];
      if (!worktree) throw Error(`Worktree ${worktreeId} isn't in ${projectPath}`);
      if (!worktree.base) throw Error("Milagre didn't create this Worktree, so it is kept.");
      if (worktree.sharedChat) throw Error("This Worktree belongs to a shared Link Chat. Archive that Chat to hide it.");
      if (caller && projectOfKey(caller) === projectPath && state.sessions[sessionIdFromKey(caller)]?.worktree_id === worktree.id)
        throw Error("A Chat can't remove the Worktree it runs in.");
      const name = (session) => `"${session.title || session.generatedTitle || "Chat"}" (${projectPath}#${session.id})`;
      const on = Object.values(state.sessions).filter((session) => session.worktree_id === worktree.id);
      const running = on.filter((session) => chats.runs?.[`${projectPath}#${session.id}`]);
      if (running.length) throw Error(`Stop ${running.map(name).join(", ")} first (chat_stop).`);
      // An empty Chat (the one a Worktree reuses for its next send) has nothing to lose; one with messages the caller
      // archives first, since its Chats go with the Worktree.
      const used = (session) => (session.summary?.count ?? 0) > 0 || (state.messages ?? []).some((message) => message.session_id === session.id);
      const open = on.filter((session) => !session.archived && used(session));
      if (open.length) throw Error(`Archive ${open.map(name).join(", ")} first (chat_update archived: true): the Worktree's Chats go with it.`);
      const status = await worktreeStatus(worktree.path, worktree.base);
      if (!status.removable)
        throw Error(
          !status.branch
            ? "It's on a detached HEAD, so it is kept."
            : status.uncommitted
              ? `It has ${status.uncommitted} uncommitted ${status.uncommitted === 1 ? "file" : "files"}, so it is kept. Commit or discard them first.`
              : `Its branch has ${status.unpushed} ${status.unpushed === 1 ? "commit" : "commits"} on neither ${worktree.base} nor its upstream, so it is kept. Push or merge them first.`,
        );
      if (caller && callerMode(caller) === "ask")
        await confirm(caller, {
          title: `Remove the Worktree "${worktree.name}"?`,
          description: "Its checkout goes, with its archived Chats. It has nothing uncommitted or unpushed.",
          detail: JSON.stringify({ worktree: worktree.path, branch: status.branch }, null, 2),
        });
      for (const session of on.filter((item) => !item.archived)) await patchChat(projectPath, session.id, { archived: true });
      const result = await removeWorktree(projectPath, worktree.path);
      return {
        removed: Boolean(result.removed),
        ...(result.branch ? { branch: result.branch, branchDeleted: Boolean(result.branchDeleted) } : {}),
      };
    },
    async reconcile(operation, args, operationId) {
      const state = await project(args.projectPath);
      if (operation === "worktree_create") {
        const worktree = Object.values(state.worktrees).find((item) => item.localMcpOperation === operationId);
        return worktree ? { projectPath: args.projectPath, worktreeId: worktree.id } : null;
      }
      if (operation === "chat_create") {
        const session = Object.values(state.sessions).find((item) => item.localMcpOperations?.includes(operationId));
        return session ? { chatId: `${args.projectPath}#${session.id}` } : null;
      }
      if (operation === "chat_start") {
        const message = await scopeStates.findMessage(args.projectPath, "operationId", operationId);
        const queued = Object.values(state.sessions).find((session) => session.queued?.some((entry) => entry.operationId === operationId));
        const sessionId = message?.session_id ?? queued?.id;
        return sessionId != null ? { chatId: `${args.projectPath}#${sessionId}`, accepted: true } : null;
      }
      return null;
    },
  };
}
module.exports = { createLocalMcpHost };

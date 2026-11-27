const crypto = require("node:crypto");
const { realpathSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { projectOfKey, sessionIdFromKey, lastUserModel } = require("@milagre/shared/agent-runs");
const { IMAGE_TYPES } = require("@milagre/shared/limits");
const { chatActivity } = require("@milagre/shared/chat-activity");
const { queue } = require("./chat-branch-tools.cjs");
const { providerCapabilities } = require("@milagre/shared/provider-capabilities");
const { callerMode: asCaller, raisesMode } = require("./agents/permissions.cjs");
const { inspectProject } = require("./project-identity.cjs");
const { ancestorChats } = require("@milagre/shared/subchat-escalation");
const { attentionContext } = require("@milagre/shared/attention");
const { isSecretRequest } = require("./chat-secrets.cjs");
const { isBugReportRequest } = require("./bug-reports.cjs");
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

function answerSummary(questions, answers) {
  const shown = (question) =>
    (answers[question.id] ?? []).map((value) => (question.secret && !question.options.some((option) => option.label === value) ? "••••••" : value)).join(", ");
  if (questions.length === 1) return shown(questions[0]);
  return questions.map((question, index) => `${question.header || `Question ${index + 1}`}: ${shown(question)}`).join("\n");
}

function kinOf(state, caller, chatId) {
  if (!caller || projectOfKey(caller) !== projectOfKey(chatId)) return null;
  const callerId = sessionIdFromKey(caller);
  const chatSession = sessionIdFromKey(chatId);
  const above = ancestorChats(state.sessions, chatSession);
  if (above.includes(callerId)) return "ancestor";
  return (ancestorChats(state.sessions, callerId).at(-1) ?? callerId) === (above.at(-1) ?? chatSession) ? "family" : null;
}

function givenAnswers(question, answers) {
  const asked = new Set(question.questions.map((item) => item.id));
  const given = Object.entries(answers ?? {}).flatMap(([id, values]) => {
    const kept = values.map((value) => value.trim()).filter(Boolean);
    return asked.has(id) && kept.length ? [[id, kept]] : [];
  });
  if (!given.length) throw Error("Give answers: the picked labels or typed text per question id.");
  return Object.fromEntries(given);
}

const WAITS_ON_THE_USER = "This Subchat is waiting on the user, so only they can";

function senderLine(from, client) {
  if (from) return `Message from the agent of Chat ${from}, sent with Milagre's chat_start (not the user):`;
  return `Message sent by ${client || "an outside client"} through Milagre's MCP (not the user):`;
}

function chatMessageContext(caller, label, client) {
  return caller ? { kind: "chat-message", from: caller, fromLabel: label } : { kind: "chat-message", from: null, fromLabel: client || "An outside client" };
}

function attachmentPrompt(body, files) {
  return files.length ? `${body}\n\nAttached files:\n${files.join("\n")}` : body;
}

function chatTools(chat, invoke, steering) {
  return {
    ...require("./chat-branch-tools.cjs").createChatBranchHost({ chat, invoke, ...steering }),
    dictationCorrections: ({ projectPath }) => invoke("dictation:corrections", [projectPath]),
    setDictationCorrection: async ({ projectPath, heard, spelling }) => {
      await invoke("dictation:correct", [projectPath, heard, spelling]);
      return { saved: Boolean(spelling.trim()) };
    },
  };
}

function createLocalMcpHost({
  invoke,
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
  suggestAnswer = () => Promise.reject(Error("Suggestions are unavailable")),
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
  registerProject = () => Promise.reject(Error("Adding Projects is unavailable")),
  assertRegistrableProject = async () => {},
  imports,
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
  const savedMode = async (caller) => {
    try {
      return (await chat(projectOfKey(caller), caller)).session.permissionMode ?? "ask";
    } catch {
      return "ask";
    }
  };
  const callerModeWith = (caller, saved) => (caller ? asCaller(permissionMode(caller, null) ?? chats.turnSettings?.(caller)?.permissionMode ?? saved) : "ask");
  const callerMode = async (caller) => callerModeWith(caller, caller ? await savedMode(caller) : "ask");
  const confirm = async (caller, request) => {
    const action = request.title.replace(/\?$/, "");
    if (!caller) throw Error(`${action} needs approval in Milagre, which an outside client can't ask for. Do it in Milagre instead.`);
    if (permissionMode(caller, null) == null)
      throw Error(
        `PERMISSION_APPROVAL_REQUIRED: ${action} needs the user's approval on a card in the calling Chat, which has no running agent to show it. Nobody declined. Run the calling Chat in a mode that allows this (Full permission does), or do it in Milagre.`,
      );
    const decision = await approve(caller, { requestId: `mcp-${crypto.randomUUID()}`, kind: "other", tool: "Milagre", allowForChat: false, ...request });
    if (decision === "cancelled")
      throw Error(`APPROVAL_CANCELLED: the card for ${action} closed before anyone answered it (the calling Chat's turn ended). Nobody declined.`);
    if (decision !== "allow" && decision !== "allow-for-chat") throw Error("The user declined.");
  };
  const checkMode = async (caller, chatId, mode, session, { prompt, asked = true, fromCaller } = {}) => {
    if (!raisesMode(mode, fromCaller ?? (await callerMode(caller)))) return false;
    const name = session?.title || session?.generatedTitle;
    const chatName = name ? `"${name}"` : "another Chat";
    const modeName = mode === "full" ? "Full permission" : "Auto mode";
    await confirm(caller, {
      ...(asked
        ? { title: `Run ${chatName} in ${modeName}?`, description: "This Chat's agent asks to give it more permission than it has itself." }
        : {
            title: `Run a prompt in ${chatName} in ${modeName}?`,
            description: `That Chat runs in ${modeName}, more than this Chat's agent has, and the prompt would run there with it.`,
          }),
      ...(prompt ? { detail: JSON.stringify({ permissionMode: mode, prompt }, null, 2) } : {}),
    });
    return true;
  };
  const callerName = async (caller) => {
    try {
      const { state, session } = await chat(projectOfKey(caller), caller);
      const branch = state.worktrees?.[session.worktree_id]?.name ?? "unknown branch";
      return `${path.basename(projectOfKey(caller))} / ${branch} / ${session.title || session.generatedTitle || "Chat"}`;
    } catch {
      return null;
    }
  };
  const runOf = (chatId) => chats.runs[chatId];
  const assertNotWaiting = (state, caller, chatId, action) => {
    if (kinOf(state, caller, chatId) !== "ancestor") return;
    const { approvals, questions } = pending(chatId);
    if (approvals.length || questions.length) throw Error(`${WAITS_ON_THE_USER} ${action} it. Tell them instead.`);
  };
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
  const familyResponse = async ({ chatId, requestId, state, approval, question, answers, suggest }, caller) => {
    if (approval) throw Error(`${WAITS_ON_THE_USER} answer this approval. Tell them what it wants and what you recommend.`);
    if (isSecretRequest(requestId) || question.questions.some((item) => item.secret)) throw Error(`${WAITS_ON_THE_USER} give this secret.`);
    if (answers === null) throw Error(`${WAITS_ON_THE_USER} dismiss this question.`);
    const given = givenAnswers(question, answers);
    const answerLabel = answerSummary(question.questions, given);
    const asked = question.questions.map((item) => item.question).join(" ");
    if (suggest) {
      const fromTitle = attentionContext(state, "", sessionIdFromKey(chatId)).chatTitle;
      await suggestAnswer(caller, { from: chatId, fromTitle, requestId, question: asked, answerLabel, answers: given });
      return { chatId, requestId, accepted: true, note: "Suggested. The human decides." };
    }
    if ((await callerMode(caller)) !== "full")
      throw Error("Only a Chat in Full permission answers a Subchat's question alone. Use suggest: true, and the human decides.");
    return {
      chatId,
      requestId,
      accepted: Boolean(await answerQuestion(chatId, requestId, given, undefined, { agent: caller, question: asked, answerLabel, answers: given })),
    };
  };
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
    await validateProject(projectPath);
    if ((await callerMode(caller)) === "full") return;
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
    importer: imports && { ...imports, confirm, callerMode },
    validateChat: validateDesignChat,
    async addProject({ projectPath }, caller, inScope = () => false, onGrant) {
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
          if ((await callerMode(caller)) !== "full")
            await confirm(caller, {
              title: `Grant this Chat access to "${name}"?`,
              description: "Project is already in Milagre. Grants this Chat access to inspect and manage its Worktrees and Chats.",
              detail: JSON.stringify({ projectPath: identity.path }, null, 2),
            });
          onGrant?.(identity.path);
        }
        return { id: existing.id, path: existing.path, name, created: false, ...(caller ? { inScope: true } : {}) };
      }
      if (!caller || (await callerMode(caller)) !== "full")
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
        ...queue(chatId, session, Boolean(chats.runs[chatId])),
        messages: messages.slice(-limit).map(({ id, role, body }) => ({ id, role, body })),
      };
    },
    async createWorktree(args, operationId, assertActive) {
      const result = await createWorktree({ localMcp: { operationId, assertActive } }, args);
      return { projectPath: args.projectPath, worktreeId: result.worktreeId, ...(result.setupNote ? { setupNote: result.setupNote } : {}) };
    },
    ...chatTools(chat, invoke, { assertNotWaiting, callerMode, confirm, chats, scopeStates }),
    async createChat({ projectPath, worktreeId }, operationId, assertActive) {
      await project(projectPath);
      assertActive();
      const id = await chats.emptyChat(projectPath, worktreeId, { operationId, assertActive });
      return { chatId: `${projectPath}#${id}` };
    },
    async startChat(
      { projectPath, chatId, prompt, provider, model, effort, permissionMode: asked, files = [], images = [] },
      operationId,
      assertActive,
      caller,
      client,
    ) {
      const { state, session } = await chat(projectPath, chatId);
      assertNotWaiting(state, caller, chatId, "send");
      if (session.archived) throw Error("This Chat is archived");
      const latest = chats.turnSettings(chatId) ?? {};
      const messages = await scopeStates.chatMessages(projectPath, [session.id]);
      const chosenModel = model || latest.model || lastUserModel({ ...state, messages }, session.id);
      if (!chosenModel) throw Error("Choose a model for this Chat before starting it");
      const chosenProvider = provider || latest.provider || session.provider || "claude";
      const entry = ((await models(projectPath))[chosenProvider] ?? []).find((item) => item.id === chosenModel);
      if (effort && entry && !entry.efforts.includes(effort)) throw Error(`${chosenModel} takes effort ${entry.efforts.join(", ") || "none"}, not ${effort}.`);
      const chosenEffort = effort ?? (entry && latest.effort && !entry.efforts.includes(latest.effort) ? entry.defaultEffort : latest.effort);
      const saved = caller ? await savedMode(caller) : "ask";
      const callerNow = () => callerModeWith(caller, saved);
      const modeNow = () => asked ?? permissionMode(chatId, callerNow());
      const mode = modeNow();
      const approved = await checkMode(caller, chatId, mode, session, { prompt, asked: Boolean(asked), fromCaller: callerNow() });
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
      const senderName = caller ? await callerName(caller) : null;
      const result = await chats.send({
        ...latest,
        projectPath,
        sessionId: session.id,
        body: prompt,
        prompt: `${senderLine(caller && (senderName ? `${senderName} (${caller})` : caller), client)}\n\n${attachmentPrompt(prompt, attached)}`,
        context: chatMessageContext(caller, senderName ?? caller, client),
        images: pictures,
        files: attached,
        provider: chosenProvider,
        model: chosenModel,
        effort: chosenEffort,
        permissionMode: mode,
        operationId,
        canStart: () => {
          assertActive();
          assertNotWaiting(state, caller, chatId, "send");
          if (modeNow() !== mode) throw Error("Chat permission mode changed; inspect the Chat before retrying");
          if (!approved && raisesMode(mode, callerNow()))
            throw Error("The calling Chat's permission mode changed to less than this needs; nothing was sent. Retry to ask the user.");
          return true;
        },
      });
      if (asked) await setPermissionMode(chatId, asked);
      return {
        chatId: `${projectPath}#${result.sessionId}`,
        accepted: true,
        ...(waits ? { note: "This Chat's agent can't take a message mid-turn: it starts this one after its running turn ends." } : {}),
      };
    },
    async stopChat({ projectPath, chatId }, caller) {
      const { state } = await chat(projectPath, chatId);
      assertNotWaiting(state, caller, chatId, "stop");
      const running = Boolean(runOf(chatId));
      await stopChat(chatId);
      return { chatId, stopped: running };
    },
    async setMode({ projectPath, chatId, permissionMode: mode }, caller) {
      const { state, session } = await chat(projectPath, chatId);
      assertNotWaiting(state, caller, chatId, "change the mode of");
      if (!runOf(chatId) && permissionMode(chatId, null) === null)
        throw Error("This Chat has no running agent. Pass permissionMode to chat_start to start it in that mode.");
      await checkMode(caller, chatId, mode, session);
      await setPermissionMode(chatId, mode);
      return { chatId, permissionMode: mode };
    },
    async respond({ projectPath, chatId, requestId, decision, answers, suggest = false }, caller) {
      const { state, session } = await chat(projectPath, chatId);
      if (caller === chatId) throw Error("A Chat can't answer its own approvals or questions.");
      const { approvals, questions } = pending(chatId);
      const approval = approvals.find((item) => item.requestId === requestId);
      const question = questions.find((item) => item.requestId === requestId);
      if (!approval && !question) throw Error("Nothing with that requestId is waiting in this Chat. chat_read lists what is.");
      if (question && isBugReportRequest(requestId))
        throw Error("Only the user can approve or cancel a Milagre bug report, after reading its exact text. Tell them it is waiting.");
      const kin = kinOf(state, caller, chatId);
      if (suggest && !kin) throw Error("suggest is for a question in this Chat's own family of Subchats.");
      if (kin) return familyResponse({ chatId, requestId, state, approval, question, answers, suggest }, caller);
      const asking = `"${session.title || session.generatedTitle || "Another Chat"}"`;
      if (approval) {
        if (!decision) throw Error("Give a decision: allow, allow-for-chat or deny.");
        if (decision !== "deny" && (await callerMode(caller)) !== "full")
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
      if (answers && (await callerMode(caller)) !== "full")
        await confirm(caller, {
          title: `Answer ${asking}'s questions?`,
          description: "This Chat's agent wants to answer them for you.",
          reason: summary,
        });
      return { chatId, requestId, accepted: Boolean(await answerQuestion(chatId, requestId, answers, summary)) };
    },
    async updateChat({ projectPath, chatId, title, archived }) {
      const { session } = await chat(projectPath, chatId);
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
    async linkWorktrees({ projectPath, worktreeId, targetProjectPath, targetWorktreeId }, caller, inScope) {
      if (!inScope(targetProjectPath) && !caller) throw Error("The target Project is outside this connection's scope");
      await validateProject(targetProjectPath);
      const a = await endpoint(projectPath, worktreeId);
      const b = await endpoint(targetProjectPath, targetWorktreeId);
      const existing = (await links.list()).find((link) => [link.a, link.b].some((end) => sameEnd(end, a)) && [link.a, link.b].some((end) => sameEnd(end, b)));
      if (existing) return { linkId: existing.id, created: false };
      if ((await callerMode(caller)) === "ask" && caller)
        await confirm(caller, {
          title: "Link this Worktree to another?",
          description: "Its agent could read the other Worktree's files, git and Chats, and send it Delegations.",
          detail: JSON.stringify({ from: a.worktree_path, to: b.worktree_path }, null, 2),
        });
      const before = new Set((await links.list()).map((link) => link.id));
      const added = (await links.add(a, b)).find((link) => !before.has(link.id));
      return { linkId: added?.id, created: true };
    },
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
      if (caller && (await callerMode(caller)) === "ask")
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
      if (operation === "chat_create" || operation === "chat_fork") {
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

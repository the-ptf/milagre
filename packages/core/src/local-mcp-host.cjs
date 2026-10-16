const { realpathSync } = require("node:fs");
const { projectOfKey, sessionIdFromKey, lastUserModel } = require("@milagre/shared/agent-runs");
const { chatActivity } = require("@milagre/shared/chat-activity");

// Narrow host ports; no caller-supplied method names or command payload forwarding.
function createLocalMcpHost({ projects, readProject, scopeStates, chats, createWorktree, validateDesignChat, permissionMode }) {
  const validateProject = async (projectPath) => {
    if (!(await projects()).some((project) => project.path === projectPath) || realpathSync(projectPath) !== projectPath)
      throw Error("Open this Project in Milagre first; its canonical path is required");
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
      backgroundAgents: background,
      approvals: run?.approvals?.length ?? 0,
      questions: run?.questions?.length ?? 0,
    };
  };
  return {
    projects,
    validateProject,
    validateChat: validateDesignChat,
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
      return { ...progress(chatId, session), messages: messages.slice(-limit).map(({ id, role, body }) => ({ id, role, body })) };
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
    async startChat({ projectPath, chatId, prompt, provider, model }, operationId, assertActive, caller) {
      const { state, session } = await chat(projectPath, chatId);
      if (session.archived) throw Error("This Chat is archived");
      const latest = chats.turnSettings(chatId) ?? {};
      const messages = await scopeStates.chatMessages(projectPath, [session.id]);
      const chosenModel = latest.model || lastUserModel({ ...state, messages }, session.id) || model;
      if (!chosenModel) throw Error("Choose a model for this Chat before starting it");
      assertActive();
      const modeNow = () => permissionMode(chatId, caller ? permissionMode(caller) : "ask");
      const mode = modeNow();
      const result = await chats.send({
        ...latest,
        projectPath,
        sessionId: session.id,
        body: prompt,
        prompt,
        images: [],
        files: [],
        provider: latest.provider || session.provider || provider || "claude",
        model: chosenModel,
        permissionMode: mode,
        operationId,
        canStart: () => {
          assertActive();
          if (modeNow() !== mode) throw Error("Chat permission mode changed; inspect the Chat before retrying");
          return true;
        },
      });
      return { chatId: `${projectPath}#${result.sessionId}`, accepted: true };
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
        return message ? { chatId: `${args.projectPath}#${message.session_id}`, accepted: true } : null;
      }
      return null;
    },
  };
}
module.exports = { createLocalMcpHost };

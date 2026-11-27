const fs = require("node:fs/promises");
const path = require("node:path");
const { chatKey, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");

const UNLISTED = "Choose a Project Milagre lists.";
const NO_CHAT = "That Chat is no longer in its Project.";

function routineTargets({ projects, openState }) {
  async function listedProject(input) {
    if (typeof input !== "string" || !path.isAbsolute(input) || input.includes("\0")) throw new Error(UNLISTED);
    const resolved = path.resolve(input);
    const real = await fs.realpath(resolved).catch(() => resolved);
    for (const project of await projects()) {
      if (project.path === real) return project.path;
      if ((await fs.realpath(project.path).catch(() => project.path)) === real) return project.path;
    }
    throw new Error(UNLISTED);
  }
  async function atStart(target, { babysit = false } = {}) {
    const folder = target?.kind === "new-chat" ? target.projectPath : target?.kind === "chat" ? projectOfKey(String(target.chatId ?? "")) : null;
    if (babysit && isLinkScopeKey(folder)) return linkChat(target.chatId);
    if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error(UNLISTED);
    if ((await fs.realpath(folder).catch(() => null)) !== folder) throw new Error(`The Project folder ${folder} moved or is no longer a folder.`);
    if (!(await projects()).some((project) => project.path === folder)) throw new Error(UNLISTED);
    if (target.kind === "chat") {
      const sessionId = sessionIdFromKey(target.chatId);
      const session = (await openState(folder, sessionId))?.sessions?.[sessionId];
      if (!session || session.archived) throw new Error(NO_CHAT);
      if (session.readOnlyReason) throw new Error(session.readOnlyReason);
    }
  }
  async function linkChat(chatId) {
    const scope = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    const state = await openState(scope, sessionId);
    const session = state?.sessions?.[sessionId];
    if (!session || session.archived || state.deletedAt) throw new Error(NO_CHAT);
    if (session.readOnlyReason) throw new Error(session.readOnlyReason);
    if (state.adoptionPending || state.releasedAt) throw new Error("This Link is changing Chat mode or has returned to separate Chats.");
    return session;
  }
  async function checkTarget(target, { babysit = false } = {}) {
    if (target?.kind === "new-chat") return { ...target, projectPath: await listedProject(target.projectPath) };
    if (target?.kind !== "chat") return target;
    if (typeof target.chatId !== "string" || !target.chatId.includes("#")) throw new Error("Choose a Chat.");
    const scope = projectOfKey(target.chatId);
    if (isLinkScopeKey(scope)) {
      if (!babysit) throw new Error(UNLISTED);
      await linkChat(target.chatId);
      return target;
    }
    const projectPath = await listedProject(scope);
    const sessionId = sessionIdFromKey(target.chatId);
    const session = (await openState(projectPath, sessionId))?.sessions?.[sessionId];
    if (!session || session.archived) throw new Error(NO_CHAT);
    if (session.readOnlyReason) throw new Error(session.readOnlyReason);
    return { kind: "chat", chatId: chatKey(projectPath, sessionId) };
  }
  return Object.assign(checkTarget, { atStart });
}

module.exports = { routineTargets };

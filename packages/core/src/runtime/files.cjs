const path = require("node:path");
const { isLinkScopeKey, scopeFromKey } = require("@milagre/shared/chat-scopes");
const { realpathSync } = require("node:fs");
const { chatPage } = require("../chat-pages.cjs");
const { discoverSkills, readDiscoveredSkill } = require("../skills.cjs");
const { listBranches } = require("../worktrees.cjs");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { resolveProjectImage } = require("../project-image.cjs");
const { dictationContext, polishDictation, createDictationModels } = require("../dictation.cjs");

function createFiles({
  options,
  dataDir,
  version,
  commands,
  environmentReady,
  searchFiles,
  states,
  scopeStates,
  projectSettings,
  chats,
  linkRuntime,
  linkWorkspaces,
  agentCli,
  accountScopeForFolder,
  recentProjects,
}) {
  const mobileUploads = require("../mobile-uploads.cjs").createMobileUploads({ dataDir: realpathSync(dataDir) });
  const attachmentTransfers = require("../attachment-transfers.cjs").createAttachmentTransfers({
    dataDir: realpathSync(dataDir),
    upload: (request) => mobileUploads.upload(request),
  });
  commands.handle("attachment:upload", async (_event, request) => {
    if (!scopeStates.has(request?.projectPath)) throw new Error("Open the Project or Link before uploading files.");
    try {
      return { file: await attachmentTransfers.receive(request) };
    } catch (error) {
      if (error.status) return { error: { status: error.status, message: error.message } };
      throw error;
    }
  });
  commands.handle("chat:send-status", async (_event, owner, clientMessageId) => {
    if (!scopeStates.has(owner) || typeof clientMessageId !== "string" || !clientMessageId) throw new Error("Choose an open Chat and message identity.");
    return chats().sendStatus(owner, clientMessageId);
  });
  async function attachmentAccess(file) {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Choose an attached file or a file in an open Worktree.");
    const roots = scopeStates.worktreePaths();
    if (await require("../attachment-preview.cjs").insideRoots(file, roots)) return { roots, attached: [] };
    const { sharedFilePaths, chatFolder } = require("../chat-files.cjs");
    const name = path.basename(file);
    const needles = [...new Set([JSON.stringify(name).slice(1, -1), encodeURIComponent(name), encodeURI(name)])];
    const attached = [];
    for (const project of scopeStates.projects()) {
      const state = await scopeStates.get(project);
      const messages = await scopeStates.messagesContaining(project, needles);
      const streaming = Object.entries(chats().snapshot().runs)
        .filter(([key]) => projectOfKey(key) === project)
        .map(([key, run]) => Object.assign({}, run, { role: "assistant", session_id: sessionIdFromKey(key) }));
      for (const message of [...(messages || []), ...streaming]) {
        attached.push(...(message.files || []));
        const body = JSON.stringify(message.body || message.text || "");
        if (needles.some((needle) => body.includes(needle)) && sharedFilePaths(message, chatFolder(state, message, project)).has(file)) attached.push(file);
      }
      if (attached.includes(file)) break;
    }
    return { roots, attached };
  }
  commands.handle("attachment:preview", async (_event, file) => {
    const { roots, attached } = await attachmentAccess(file);
    return require("../attachment-preview.cjs").readAttachment(file, roots, attached);
  });
  commands.handle("attachment:read", async (_event, file, offset = 0, version) => {
    const { roots, attached } = await attachmentAccess(file);
    return require("../attachment-download.cjs").readAttachmentChunk(file, offset, version || undefined, roots, attached);
  });
  commands.handle("project:files", async (_event, root, query) => {
    if (!scopeStates.worktreePaths().includes(root) && !scopeStates.workspacePaths().includes(root)) throw new Error("Choose an open project's worktree.");
    if (scopeStates.workspacePaths().includes(root)) {
      const roots = await linkRuntime().workspace(root);
      return (await Promise.all(roots.map(async (member) => (await searchFiles(member.worktreePath, query)).map((file) => `${member.alias}/${file}`)))).flat();
    }
    return searchFiles(root, query);
  });
  commands.handle("dictation:context", async (_event, { cwd, chatTitle, scope, chatId } = {}) => {
    await knownFolder(cwd);
    return dictationContext({ cwd, chatTitle, listFiles: searchFiles.list, messages: await dictationMessages(scope, chatId) });
  });
  async function dictationMessages(scope, chatId) {
    if (typeof scope !== "string" || !states.has(scope) || !Number.isSafeInteger(chatId)) return [];
    try {
      const { messages } = chatPage((await scopeStates.load(scope, [chatId])).messages, chatId, { turns: 6, limit: 40 });
      return messages.map((message) => message.body).filter((body) => typeof body === "string");
    } catch {
      return [];
    }
  }
  commands.handle("dictation:polish", async (_event, { cwd, text, chatTitle, provider, model, scope, chatId } = {}) => {
    await knownFolder(cwd);
    const { terms } = await dictationContext({ cwd, chatTitle, listFiles: searchFiles.list, messages: await dictationMessages(scope, chatId) });
    const models =
      options.dictationModels ?? createDictationModels({ cli: async (name) => agentCli(name, await accountScopeForFolder(cwd)), clientVersion: version });
    const picked = typeof model === "string" && model !== "auto" ? model : null;
    return polishDictation({ text, terms, chatTitle, provider: picked ?? provider, only: Boolean(picked) }, { models });
  });
  async function knownFolder(folder) {
    if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("An absolute Project path is required");
    if (states.has(folder) || scopeStates.worktreePaths().includes(folder) || scopeStates.workspacePaths().includes(folder)) return;
    if ((await recentProjects().list()).some((item) => item.path === folder)) return;
    throw new Error("Open this project in Milagre first.");
  }
  async function skillRoots(folder) {
    if (isLinkScopeKey(folder)) {
      const link = await linkRuntime().definition(scopeFromKey(folder).linkId);
      return (await linkWorkspaces().membersAvailable(link)).map((project) => project.path);
    }
    await knownFolder(folder);
    return folderSkillRoots(folder);
  }
  async function folderSkillRoots(folder) {
    if (!scopeStates.workspacePaths().includes(folder)) return folder;
    return linkRuntime().workspaceSkillRoots(folder);
  }
  commands.handle("skills:list", async (_event, projectPath) => discoverSkills(projectPath === null ? null : await skillRoots(projectPath)));
  commands.handle("skills:read", async (_event, projectPath, file) => readDiscoveredSkill(projectPath === null ? null : await skillRoots(projectPath), file));
  commands.handle("project:branches", async (_event, projectPath) => {
    await knownFolder(projectPath);
    return listBranches(projectPath);
  });
  async function projectImage(projectPath) {
    await knownFolder(projectPath);
    const { icon } = await projectSettings().get(projectPath);
    if (icon) return icon;
    await environmentReady;
    return resolveProjectImage(projectPath);
  }
  commands.handle("project:image", (_event, projectPath) => projectImage(projectPath));
  commands.handle("project:set-icon", async (_event, projectPath, icon) => {
    await knownFolder(projectPath);
    await projectSettings().setIcon(projectPath, icon ?? null);
    return projectImage(projectPath);
  });
  return { mobileUploads, attachmentTransfers, knownFolder, folderSkillRoots };
}

module.exports = { createFiles };

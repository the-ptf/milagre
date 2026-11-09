const { scopeFromKey, scopeKey, isLinkScopeKey } = require("@milagre/shared/chat-scopes");
// What a shared Chat's agent is told about its Projects: the Worktrees it already has, and the Projects it has only read.
function linkInstructions(worktrees, pending) {
  return [
    "This is one shared Chat in a named Project Link. Its Worktrees are made only in the Projects it changes.",
    worktrees.length
      ? `These Worktrees belong to this Chat and may be edited directly under its permission mode:\n${worktrees.map((member) => `${member.alias}: ${member.worktreePath}`).join("\n")}`
      : "",
    pending.length
      ? `These Projects have no Worktree in this Chat yet. Read them in their main checkout, which you must never edit:\n${pending.map((project) => `${project.projectName ?? project.alias}: ${project.projectPath}`).join("\n")}\nBefore you change any file in one of them, call Milagre's link_worktree tool with its Project name. It makes this Chat's Worktree there and returns its path; make every change in that path. Don't call it for a Project you only read.`
      : "",
    "Read each member's AGENTS.md and provider instructions before editing it. Run Git commands in the chosen member Worktree. The workspace directory is not a repository. Main checkouts are outside the owned set. External canvas-linked Worktrees still follow the read-only and Delegation rules above.",
  ]
    .filter(Boolean)
    .join("\n");
}
function createChatScopes({ projects, links, validateLink }) {
  const target = (key) => {
    const scope = scopeFromKey(key);
    return scope.kind === "link" ? [links, scope.linkId] : [projects, scope.projectPath];
  };
  return {
    has(key) {
      const [store, id] = target(key);
      return store.has(id);
    },
    projects: () => [...projects.projects(), ...links.ids().map((linkId) => scopeKey({ kind: "link", linkId }))],
    worktreePaths: () => [
      ...projects.worktreePaths(),
      ...links
        .ids()
        .flatMap((id) => Object.values(links.cached(id)?.sessions ?? {}).flatMap((session) => session.worktrees.map((member) => member.worktreePath))),
    ],
    workspacePaths: () => links.ids().flatMap((id) => Object.values(links.cached(id)?.sessions ?? {}).map((session) => session.workspacePath)),
    get(key) {
      const [store, id] = target(key);
      return store.get(id);
    },
    update(key, change, options) {
      const [store, id] = target(key);
      return store.update(id, change, options);
    },
    // Messages of Chats that may be unloaded (see message-store.cjs): ProjectStates' readers, by scope key.
    load(key, chats) {
      const [store, id] = target(key);
      return store.load(id, chats);
    },
    allMessages(key, options) {
      const [store, id] = target(key);
      return store.allMessages(id, options);
    },
    chatMessages(key, chats) {
      const [store, id] = target(key);
      return store.chatMessages(id, chats);
    },
    inboxState(key) {
      const [store, id] = target(key);
      return store.inboxState(id);
    },
    messageMarks(key, options) {
      const [store, id] = target(key);
      return store.messageMarks(id, options);
    },
    messagesContaining(key, needles) {
      const [store, id] = target(key);
      return store.messagesContaining(id, needles);
    },
    searchableMessages(key, chats) {
      const [store, id] = target(key);
      return store.searchableMessages(id, chats);
    },
    findMessage(key, field, value) {
      const [store, id] = target(key);
      return store.findMessage(id, field, value);
    },
    flush(key) {
      if (key === undefined) return Promise.all([projects.flush(), links.flush()]);
      const [store, id] = target(key);
      return store.flush(id);
    },
    storageDirectory(key) {
      const scope = scopeFromKey(key);
      return scope.kind === "link" ? links.directory(scope.linkId) : scope.projectPath;
    },
    async executionContext(key, sessionId) {
      const [store, id] = target(key);
      const state = await store.get(id);
      const session = state.sessions[sessionId];
      if (!session) throw new Error("Chat no longer exists");
      if (!isLinkScopeKey(key)) return { cwd: state.worktrees[session.worktree_id]?.path };
      await validateLink(id);
      const fs = require("node:fs/promises");
      const path = require("node:path");
      const git = require("./git/client.cjs").createGit().read;
      for (const member of session.worktrees) {
        try {
          if ((await fs.realpath(member.worktreePath)) !== member.worktreePath) throw new Error("Worktree target changed");
          // The branch is not part of the identity: the agent may switch or rename it (fix/..., renameWorktreeBranch).
          const registered = (await git.worktreeList(member.projectPath)).find((entry) => entry.path === member.worktreePath);
          if (!registered || (await git.commonDir(member.worktreePath)) !== (await git.commonDir(member.projectPath)))
            throw new Error("Worktree identity changed");
          if ((await fs.realpath(path.join(session.workspacePath, member.alias))) !== member.worktreePath) throw new Error("Workspace alias changed");
        } catch {
          throw new Error(`Project ${member.projectName || member.alias}: its shared Worktree is unavailable.`);
        }
      }
      // A Chat from before Worktrees were made on demand has one in every Project, and no project list.
      const projects = session.projects ?? session.worktrees;
      const made = new Set(session.worktrees.map((member) => member.projectId));
      const pending = projects.filter((project) => !made.has(project.projectId));
      return {
        cwd: session.workspacePath,
        workspaceRoots: session.worktrees.map((member) => member.worktreePath),
        // Projects without a Worktree yet are read from their main checkout, which the agent reads without asking.
        readRoots: pending.map((project) => project.projectPath),
        workspaceInstructions: linkInstructions(session.worktrees, pending),
      };
    },
  };
}
module.exports = { createChatScopes };

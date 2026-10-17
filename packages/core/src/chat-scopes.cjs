const { scopeFromKey, scopeKey, isLinkScopeKey } = require("@milagre/shared/chat-scopes");
/**
 * What a shared Link Chat's agent is told about its Projects. A Project gets its Worktree only when the agent is about
 * to edit it (link_worktree_create), so a Chat that changes one Project leaves the others' branches and folders alone.
 */
function linkWorkspaceInstructions(worktrees, pending) {
  const owned = worktrees.length
    ? `The following Worktrees belong to this Chat and may be edited directly under its permission mode:\n${worktrees.map((member) => `${member.alias}: ${member.worktreePath}`).join("\n")}`
    : "No Project has a Worktree in this Chat yet.";
  const waiting = pending.length
    ? `\nThese Projects have no Worktree in this Chat yet. Read them from their main checkout, and never edit, commit or run setup there:\n${pending.map((project) => `${project.name}: ${project.path}`).join("\n")}\nBefore the first change in one of them, call the milagre link_worktree_create tool with its name. It creates this Chat's Worktree and branch in that Project and returns the path; make every change there. Only create a Worktree in a Project you are going to change.`
    : "";
  return `This is one shared Chat in a named Project Link. ${owned}${waiting}\nRead each member's AGENTS.md and provider instructions before editing it. Run Git commands in the chosen member Worktree. The workspace directory is not a repository. Main checkouts are outside the owned set. External canvas-linked Worktrees still follow the read-only and Delegation rules above.`;
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
      // The Link's Projects, each { id, name, path }: the ones without a Worktree in this Chat yet are read from their main checkout.
      const projectsOfLink = (await validateLink(id)) ?? [];
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
      const pending = projectsOfLink.filter((project) => !session.worktrees.some((member) => member.projectId === project.id));
      return {
        cwd: session.workspacePath,
        workspaceRoots: session.worktrees.map((member) => member.worktreePath),
        projectRoots: projectsOfLink.map((project) => project.path),
        readOnlyRoots: pending.map((project) => project.path),
        workspaceInstructions: linkWorkspaceInstructions(session.worktrees, pending),
        sharedLink: true,
      };
    },
  };
}
module.exports = { createChatScopes, linkWorkspaceInstructions };

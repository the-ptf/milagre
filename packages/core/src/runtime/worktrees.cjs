const path = require("node:path");
const { syncMainBranch } = require("../main-sync.cjs");
const fs = require("node:fs/promises");
const { DEFAULT_WORKTREE_ROOT, branchPushed, createWorktree, moveWorktreeBranch, newSuffix, renameWorktreeBranch } = require("../worktrees.cjs");
const { resolveBranchPolicy, availablePolicyBranch } = require("../branch-policy.cjs");
const { branchSlug, branchTicket } = require("@milagre/shared/branch-policy");
const { suggestWorktreeName } = require("../worktree-name.cjs");
const { removeWorktree, worktreeStatus } = require("../worktree-cleanup.cjs");
const { previewFilesToCopy } = require("../worktree-files.cjs");
const { createProjectSettings } = require("../project-settings.cjs");
const { resolveSetupCommand } = require("../worktree-setup.cjs");
const { isIssueKey } = require("../linear/links.cjs");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { renameWorktree } = require("@milagre/shared/project-edits");
const { isFolderChatsHome, createFolderChat } = require("../chats-home-folders.cjs");

function createWorktreeBasics({
  options,
  dataDir,
  commands,
  environmentReady,
  knownFolder,
  linkStore,
  ownProject,
  readProject,
  states,
  releaseChat,
  retireChat,
  worktreeSetups,
  pruneLinks,
}) {
  function worktreeRoot() {
    return options.worktreeRoot || DEFAULT_WORKTREE_ROOT;
  }

  let projectSettingsStore = null;
  function projectSettings() {
    projectSettingsStore ??= createProjectSettings(path.join(dataDir, "project-settings.json"));
    return projectSettingsStore;
  }

  commands.handle("worktree:roots", async () => {
    const root = worktreeRoot();
    return [...new Set([root, await fs.realpath(root).catch(() => root)])];
  });
  commands.handle("worktree:status", async (_event, worktreePath, base) => {
    await knownFolder(worktreePath);
    await environmentReady;
    return worktreeStatus(worktreePath, base);
  });
  const removals = new Map();
  commands.handle("worktree:remove", async (_event, worktreePath, options) => {
    if ((await linkStore.ownedWorktrees()).has(worktreePath)) throw new Error("This Worktree belongs to a shared Link Chat. Archive the Chat to hide it.");
    const { force, projectPath, chatId, seen } = options && typeof options === "object" ? options : {};
    if (typeof projectPath !== "string" || !states.has(projectPath)) throw new Error("Open this project in Milagre first.");
    if (typeof worktreePath !== "string" || !path.isAbsolute(worktreePath)) throw new Error("An absolute worktree path is required.");
    await ownProject(projectPath);
    const key = `${projectPath}\0${worktreePath}`;
    const earlier = removals.get(key);
    const removal = (async () => {
      const before = earlier ? await earlier.catch(() => null) : null;
      if (before?.removed && !worktreeAt(await states.get(projectPath), worktreePath))
        return { removed: false, alreadyRemoved: true, branch: before.branch, branchDeleted: false };
      return removeOwnWorktree({ worktreePath, projectPath, chatId, seen, force: Boolean(force) });
    })();
    removals.set(key, removal);
    try {
      return await removal;
    } finally {
      if (removals.get(key) === removal) removals.delete(key);
    }
  });
  const worktreeAt = (state, worktreePath) => Object.values(state.worktrees ?? {}).find((worktree) => worktree.path === worktreePath);
  async function openAsProject(folder) {
    const real = await fs.realpath(folder).catch(() => folder);
    for (const projectPath of states.projects()) {
      if (projectPath === folder || (await fs.realpath(projectPath).catch(() => projectPath)) === real) return true;
    }
    return false;
  }
  async function removeOwnWorktree({ worktreePath, projectPath, chatId, seen, force }) {
    const worktree = worktreeAt(await states.get(projectPath), worktreePath);
    if (!worktree) throw new Error(`${worktreePath} isn't a worktree of this project, so it is kept.`);
    if (!worktree.base) throw new Error(`Milagre didn't create ${worktreePath}, so it is kept.`);
    if (await openAsProject(worktreePath)) throw new Error(`${worktreePath} is open as a project, so it is kept.`);
    const inUse = (state) => {
      if (chatId !== undefined) {
        const own = typeof chatId === "string" && projectOfKey(chatId) === projectPath ? state.sessions[sessionIdFromKey(chatId)] : undefined;
        if (!own || own.worktree_id !== worktree.id) throw new Error("That chat isn't on this worktree, so the worktree is kept.");
      }
      const others = Object.values(state.sessions).filter(
        (session) => session.worktree_id === worktree.id && !session.archived && `${projectPath}#${session.id}` !== chatId,
      );
      if (others.length) throw new Error("Another chat uses this worktree now, so it is kept.");
    };
    inUse(await states.get(projectPath));
    const goneChats = Object.values((await states.get(projectPath)).sessions)
      .filter((session) => session.worktree_id === worktree.id)
      .map((session) => `${projectPath}#${session.id}`);
    await environmentReady;
    const result = await removeWorktree({
      path: worktreePath,
      root: worktreeRoot(),
      projectPath,
      base: worktree.base,
      seen,
      force,
      closeSession: async () => {
        for (const gone of goneChats) await releaseChat(gone);
        if (typeof chatId === "string") await worktreeSetups().forget(worktreePath);
        inUse(await states.get(projectPath));
      },
    });
    if (states.has(projectPath)) await readProject(projectPath);
    if (result.removed) {
      for (const id of goneChats) await retireChat(id, { mode: "worktree-removal" });
      await pruneLinks();
    }
    return result;
  }
  return { worktreeRoot, projectSettings, worktreeAt, openAsProject };
}

function registerWorktreeSettings({ emit, commands, environmentReady, knownFolder, git, projectSettings }) {
  commands.handle("files-to-copy:read", async (_event, projectPath) => {
    await knownFolder(projectPath);
    await environmentReady;
    const { filesToCopy } = await projectSettings().get(projectPath);
    return { filesToCopy, ...(await previewFilesToCopy(projectPath, filesToCopy)) };
  });
  commands.handle("files-to-copy:preview", async (_event, projectPath, patterns) => {
    await knownFolder(projectPath);
    await environmentReady;
    return previewFilesToCopy(projectPath, patterns);
  });
  commands.handle("files-to-copy:save", async (_event, projectPath, patterns) => {
    await knownFolder(projectPath);
    await environmentReady;
    const { filesToCopy } = await projectSettings().setFilesToCopy(projectPath, patterns);
    return { filesToCopy, ...(await previewFilesToCopy(projectPath, filesToCopy)) };
  });
  async function readProjectGit(projectPath) {
    return resolveBranchPolicy(projectPath, await projectSettings().getGit(projectPath));
  }
  async function defaultProjectBase(projectPath) {
    return (await readProjectGit(projectPath)).effective.baseBranch || (await git.resolveBase(projectPath).catch(() => ({ name: "main" }))).name;
  }
  commands.handle("project-git:read", async (_event, projectPath) => {
    await knownFolder(projectPath);
    return readProjectGit(projectPath);
  });
  commands.handle("project-git:save", async (_event, projectPath, value) => {
    await knownFolder(projectPath);
    const resolved = await resolveBranchPolicy(projectPath, value);
    await projectSettings().setGit(projectPath, resolved.local);
    return resolved;
  });
  async function readSetupCommand(projectPath) {
    const { setupCommand } = await projectSettings().get(projectPath);
    return { setupCommand, ...(await resolveSetupCommand(projectPath, setupCommand)) };
  }
  commands.handle("worktree-setup:read", async (_event, projectPath) => {
    await knownFolder(projectPath);
    return readSetupCommand(projectPath);
  });
  commands.handle("worktree-setup:save", async (_event, projectPath, command) => {
    await knownFolder(projectPath);
    await projectSettings().setSetupCommand(projectPath, typeof command === "string" ? command : "");
    return readSetupCommand(projectPath);
  });
  async function readMainSync(projectPath) {
    const [settings, base] = await Promise.all([projectSettings().getMainSync(projectPath), git.resolveBase(projectPath).catch(() => ({ name: "main" }))]);
    return { branch: base.name, ...settings };
  }
  const mainSyncs = new Map();
  const mainSyncTails = new Map();
  function syncMain(projectPath, branch) {
    const key = JSON.stringify([projectPath, branch]);
    let running = mainSyncs.get(key);
    if (!running) {
      running = (mainSyncTails.get(projectPath) ?? Promise.resolve())
        .catch(() => {})
        .then(() => syncMainBranch(projectPath, { branch }))
        .then(async (last) => {
          await projectSettings()
            .recordMainSync(projectPath, last)
            .catch((error) => console.warn("Milagre main sync:", error.message));
          emit("main-sync:status", { projectPath, last });
          return last;
        })
        .finally(() => {
          mainSyncs.delete(key);
          if (mainSyncTails.get(projectPath) === running) mainSyncTails.delete(projectPath);
        });
      mainSyncs.set(key, running);
      mainSyncTails.set(projectPath, running);
    }
    return running;
  }
  commands.handle("main-sync:read", async (_event, projectPath) => {
    await knownFolder(projectPath);
    await environmentReady;
    return readMainSync(projectPath);
  });
  commands.handle("main-sync:save", async (_event, projectPath, override) => {
    await knownFolder(projectPath);
    await projectSettings().setMainSyncOverride(projectPath, typeof override === "boolean" ? override : null);
    await environmentReady;
    return readMainSync(projectPath);
  });
  commands.handle("main-sync:default:read", () => projectSettings().getMainSyncDefault());
  commands.handle("main-sync:default:save", (_event, value) => projectSettings().setMainSyncDefault(value === true));
  return { readProjectGit, defaultProjectBase, readSetupCommand, syncMain };
}

function registerWorktreeCreation({
  emit,
  commands,
  background,
  chatsHome,
  diffs,
  environmentReady,
  ownProject,
  readProject,
  states,
  track,
  updateProject,
  git,
  closing,
  linear,
  linearIssues,
  worktreeSetups,
  readPullRequestStateOf,
  agentCli,
  markIssueStarted,
  worktreeRoot,
  projectSettings,
  readProjectGit,
  syncMain,
}) {
  async function readLinearIssue(key, workspace) {
    if (!linear().enabled()) throw new Error("Linear is off in Settings › Connections › Linear.");
    if (!linear().workspaces().length) throw new Error("Linear isn't connected.");
    const issue = await linearIssues().readIssue(key, workspace);
    if (!issue) throw new Error(`${key} no longer exists in Linear.`);
    return issue;
  }

  async function nameWorktree(projectPath, created, prompt, policy, suffix, ticket) {
    const cli = await agentCli("claude", projectPath);
    const slug = await suggestWorktreeName(prompt, {
      command: cli.problem ? null : cli.command,
      env: cli.env,
      timeoutMs: 15_000,
      instructions: policy.instructions,
    });
    if (closing()) return;
    const name = await renameWorktreeBranch({ worktreePath: created.path, branch: created.branch, slug, policy, suffix, ticket });
    if (!name) return;
    await updateProject(projectPath, (state) => renameWorktree(state, { path: created.path, from: created.branch, name }), { chats: [] });
    emit("worktree:renamed", { projectPath, path: created.path, from: created.branch, name });
  }

  commands.handle("worktree:create", async (event, { projectPath, baseBranch, useProjectBase, prompt, issueKey, issueWorkspace }) => {
    await ownProject(projectPath);
    await environmentReady;
    if (chatsHome.isHome(projectPath) && (await isFolderChatsHome(projectPath))) {
      if (issueKey) throw new Error("A Chat without a Project cannot be linked to a Linear issue.");
      event?.localMcp?.assertActive();
      const folder = await createFolderChat(projectPath);
      const project = await readProject(projectPath);
      const worktree = Object.values(project.state.worktrees).find((item) => item.path === folder);
      return { project, worktreeId: worktree.id };
    }
    const issue = typeof issueKey === "string" ? await readLinearIssue(issueKey, issueWorkspace) : null;
    const policy = (await readProjectGit(projectPath)).effective;
    baseBranch = (useProjectBase && policy.baseBranch) || baseBranch || policy.baseBranch || (await git.resolveBase(projectPath)).name;
    const request = { projectPath, baseBranch, prompt };
    const suffix = newSuffix();
    const ticket = issue?.key || branchTicket(prompt);
    const branch = await availablePolicyBranch(
      projectPath,
      policy,
      { slug: issue?.title || prompt || "chat", ticket, suffix },
      { issueBranch: issue ? issue.branchName || "" : undefined },
    );
    const settings = await projectSettings().get(projectPath);
    const synced = (await projectSettings().getMainSync(projectPath)).enabled ? await syncMain(projectPath, baseBranch) : null;
    const created = await createWorktree({
      ...request,
      branch,
      folderSlug: branchSlug(issue ? branch.split("/").pop() : prompt || "chat"),
      trackBase: policy.trackBase,
      suffix,
      root: worktreeRoot(),
      copyPatterns: settings.filesToCopy,
      fetched: synced?.branch === baseBranch,
      beforeCreate: event?.localMcp?.assertActive,
    });
    if (created.copy?.notes.length) console.warn("Milagre worktree file copy:", created.copy.notes.join(" "));
    const resolved = await resolveSetupCommand(projectPath, settings.setupCommand);
    await worktreeSetups().prepare({ worktreePath: created.path, projectPath, resolved });
    const project = await readProject(request.projectPath);
    const listed = Object.values(project.state.worktrees).find((item) => item.name === created.branch);
    if (!listed) throw new Error(`Created ${created.branch}, but git did not list it as a worktree.`);
    const state = await updateProject(
      request.projectPath,
      (latest) => {
        const worktree = latest.worktrees[listed.id];
        return worktree
          ? {
              ...latest,
              worktrees: {
                ...latest.worktrees,
                [worktree.id]: {
                  ...worktree,
                  base: created.base,
                  generatedBranch: created.branch,
                  branchSuffix: suffix,
                  ...(event?.localMcp ? { localMcpOperation: event.localMcp.operationId } : {}),
                  ...(issue ? { linearIssue: issue.key, linearWorkspace: issue.workspace } : {}),
                },
              },
            }
          : latest;
      },
      { chats: [] },
    );
    if (issue) markIssueStarted(issue);
    if (!issue) void track(() => nameWorktree(request.projectPath, created, request.prompt ?? "", policy, suffix, ticket), background).catch(() => {});
    return { project: { ...project, state }, worktreeId: listed.id, ...(resolved.note ? { setupNote: resolved.note } : {}) };
  });
  commands.handle("worktree:link-issue", async (_event, { projectPath, worktreeId, key, workspace } = {}) => {
    await ownProject(projectPath);
    await environmentReady;
    if (!isIssueKey(key)) throw new Error(`${JSON.stringify(String(key))} isn't a Linear issue key.`);
    const issue = await readLinearIssue(key, workspace);
    const project = await readProject(projectPath);
    const worktree = project.state.worktrees[worktreeId];
    if (!worktree) throw new Error("That worktree is no longer in this project.");
    if (worktree.path === projectPath) throw new Error("The main checkout can't be linked to a Linear issue.");
    const sharing = Object.values(project.state.sessions).filter((session) => session.worktree_id === worktreeId && !session.archived);
    if (sharing.length > 1) throw new Error("Another chat uses this worktree, so it can't be linked to a Linear issue.");
    let renamable = false;
    if ((worktree.generatedBranch === worktree.name || worktree.name.startsWith("milagre/")) && !(await branchPushed(worktree.path, worktree.name))) {
      const lookup = await readPullRequestStateOf()(worktree.path).catch(() => ({ known: false, pr: null }));
      renamable = lookup.known && lookup.pr === null;
    }
    if (renamable) {
      const suffix = worktree.branchSuffix ?? worktree.name.match(/-([a-z0-9]{4})$/)?.[1] ?? newSuffix();
      const policy = (await readProjectGit(projectPath)).effective;
      const branch = await availablePolicyBranch(projectPath, policy, { slug: issue.title, ticket: issue.key, suffix }, { issueBranch: issue.branchName });
      if (branch !== worktree.name) await moveWorktreeBranch({ worktreePath: worktree.path, from: worktree.name, to: branch });
      const state = await updateProject(
        projectPath,
        (latest) => {
          const renamed = renameWorktree(latest, { path: worktree.path, from: worktree.name, name: branch });
          const item = renamed.worktrees[worktreeId];
          return item
            ? { ...renamed, worktrees: { ...renamed.worktrees, [worktreeId]: { ...item, linearIssue: issue.key, linearWorkspace: issue.workspace } } }
            : renamed;
        },
        { chats: [] },
      );
      emit("worktree:renamed", { projectPath, path: worktree.path, from: worktree.name, name: branch });
      return { project: { ...project, state }, mode: "renamed", branch };
    }
    const state = await updateProject(
      projectPath,
      (latest) => {
        const item = latest.worktrees[worktreeId];
        return item
          ? { ...latest, worktrees: { ...latest.worktrees, [worktreeId]: { ...item, linearIssue: issue.key, linearWorkspace: issue.workspace } } }
          : latest;
      },
      { chats: [] },
    );
    return { project: { ...project, state }, mode: "stored", branch: worktree.name };
  });
  commands.handle("worktree:unlink-issue", async (_event, { projectPath, worktreeId } = {}) => {
    await ownProject(projectPath);
    await environmentReady;
    const project = await readProject(projectPath);
    if (!project.state.worktrees[worktreeId]) throw new Error("That worktree is no longer in this project.");
    const state = await updateProject(
      projectPath,
      (latest) => {
        const item = latest.worktrees[worktreeId];
        if (!item) return latest;
        const { linearWorkspace: _workspace, ...rest } = item;
        return { ...latest, worktrees: { ...latest.worktrees, [worktreeId]: { ...rest, linearIssue: null } } };
      },
      { chats: [] },
    );
    return { project: { ...project, state } };
  });
  commands.handle("worktree:refresh-diffs", (_event, projectPath, worktreeIds) => {
    if (!states.has(projectPath) || !Array.isArray(worktreeIds)) return undefined;
    return diffs.refresh(
      projectPath,
      worktreeIds.filter((id) => Number.isInteger(id)),
    );
  });
  return { readLinearIssue };
}

function createWorktrees({
  options,
  dataDir,
  emit,
  commands,
  background,
  chatsHome,
  diffs,
  environmentReady,
  knownFolder,
  linkStore,
  ownProject,
  readProject,
  states,
  track,
  updateProject,
  git,
  closing,
  releaseChat,
  retireChat,
  linear,
  linearIssues,
  worktreeSetups,
  readPullRequestStateOf,
  agentCli,
  markIssueStarted,
  pruneLinks,
}) {
  const { worktreeRoot, projectSettings, worktreeAt, openAsProject } = createWorktreeBasics({
    options,
    dataDir,
    commands,
    environmentReady,
    knownFolder,
    linkStore,
    ownProject,
    readProject,
    states,
    releaseChat,
    retireChat,
    worktreeSetups,
    pruneLinks,
  });
  const { readProjectGit, defaultProjectBase, readSetupCommand, syncMain } = registerWorktreeSettings({
    emit,
    commands,
    environmentReady,
    knownFolder,
    git,
    projectSettings,
  });
  const { readLinearIssue } = registerWorktreeCreation({
    emit,
    commands,
    background,
    chatsHome,
    diffs,
    environmentReady,
    ownProject,
    readProject,
    states,
    track,
    updateProject,
    git,
    closing,
    linear,
    linearIssues,
    worktreeSetups,
    readPullRequestStateOf,
    agentCli,
    markIssueStarted,
    worktreeRoot,
    projectSettings,
    readProjectGit,
    syncMain,
  });
  return { worktreeRoot, projectSettings, worktreeAt, openAsProject, readProjectGit, defaultProjectBase, readSetupCommand, readLinearIssue };
}

module.exports = { createWorktrees };

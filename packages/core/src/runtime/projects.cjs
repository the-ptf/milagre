const path = require("node:path");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { originId } = require("@milagre/shared/project-origin");
const { realpathSync, existsSync } = require("node:fs");
const { withDetails, loadSubagent } = require("../project-content.cjs");
const { chatPage, chatSearch } = require("../chat-pages.cjs");
const { createChatSearch } = require("../chat-search.cjs");
const { dbFile: chatDbFile, readChatRows } = require("../chat-db.cjs");
const { createProjectFinder } = require("../project-finder.cjs");
const { scanFolder } = require("../folder-scan.cjs");
const { switchTarget } = require("../recent-projects.cjs");
const { agentFolders } = require("../agent-folders.cjs");
const { createOnboardingProjects } = require("../onboarding-projects.cjs");

function registerProjectLists({ options, commands, withoutHomes, knownFolder, openProject, projectRegistry, projectSettings, recentProjects, git }) {
  async function withHidden(list) {
    const hidden = await projectSettings().hiddenPaths();
    return list.map((project) => (hidden.has(project.path) ? { ...project, hidden: true } : project));
  }
  const origins = new Map();
  function projectOrigin(projectPath) {
    let origin = origins.get(projectPath);
    if (!origin) {
      origin = git.checked(projectPath, ["remote", "get-url", "origin"]).then(
        ({ stdout }) => originId(stdout),
        () => null,
      );
      origins.set(projectPath, origin);
    }
    return origin;
  }
  const withOrigins = (list) =>
    Promise.all(
      list.map(async (project) => {
        const origin = await projectOrigin(project.path);
        return origin ? { ...project, origin } : project;
      }),
    );
  commands.handle("project:recent", async () => withOrigins(withoutHomes(await withHidden(await recentProjects().list()))));
  commands.handle("project:known", async () => {
    const known = withoutHomes(await projectRegistry().list())
      .map((project) => ({ path: project.path, name: project.name || path.basename(project.path), openedAt: project.openedAt ?? "" }))
      .toSorted((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
    return withOrigins(known);
  });
  commands.handle("onboarding:agent-folders", async () => withoutHomes(await (options.agentFolders ?? agentFolders)()));
  const onboardingProjects = options.onboardingProjects ?? createOnboardingProjects();
  commands.handle("onboarding:create", async (_event, name) => openProject((await onboardingProjects.create(name)).path));
  commands.handle("onboarding:clone", async (_event, url, parent) => openProject((await onboardingProjects.clone(url, parent)).path));
  commands.handle("onboarding:init-git", async (_event, folder) => openProject((await onboardingProjects.initGit(folder)).path));
  commands.handle("project:set-hidden", async (_event, projectPath, hidden) => {
    await knownFolder(projectPath);
    await projectSettings().setHidden(projectPath, hidden === true);
    return withHidden(await recentProjects().list());
  });
  return { withHidden, projectOrigin };
}

function registerCanvas({
  commands,
  withoutHomes,
  agents,
  chats,
  broadcastProjectState,
  canvasActiveWorktrees,
  chatsHome,
  linkStore,
  linked,
  linksChanged,
  openProject,
  ownProject,
  projectRegistry,
  pruneLinks,
  readProject,
  recentProjects,
  states,
  git,
  routines,
  withHidden,
}) {
  commands.handle("project:registry", async () => withoutHomes(await projectRegistry().list()));
  commands.handle("project:position", (_event, id, position) => projectRegistry().setPosition(id, position));
  commands.handle("canvas:snapshot", async () => {
    await projectRegistry().list();
    await pruneLinks(await canvasActiveWorktrees());
    const registry = await projectRegistry().snapshot();
    const recent = await withHidden(await recentProjects().list());
    const sidebarPaths = new Set(recent.filter((p) => !p.hidden).map((p) => p.path));
    const linkedIds = new Set();
    for (const link of registry.links) {
      if (link.a?.project_id) linkedIds.add(link.a.project_id);
      if (link.b?.project_id) linkedIds.add(link.b.project_id);
    }
    for (const group of registry.projectGroups || []) {
      for (const id of group.projectIds) linkedIds.add(id);
    }
    registry.projects = registry.projects.filter((project) => sidebarPaths.has(project.path) || linkedIds.has(project.id));
    const statesByPath = await Promise.all(registry.projects.map(async (project) => ({ path: project.path, state: (await readProject(project.path)).state })));
    return { ...registry, links: await canvasChatModes.describe(registry.links), states: statesByPath };
  });
  async function addLink(a, b) {
    const active = await canvasActiveWorktrees();
    const before = new Set((await projectRegistry().snapshot()).links.map((link) => link.id));
    await projectRegistry().addLink(a, b, active);
    const links = await linksChanged();
    const added = links.find((link) => !before.has(link.id));
    if (added) void linked.linkAdded(added, active).catch((error) => console.warn("Milagre couldn't mark the linked Chats:", error.message));
    return links;
  }
  async function removeLink(id) {
    return canvasChatModes.remove(id, async () => {
      await projectRegistry().removeLink(id);
      await linked.linkRemoved(id);
      return linksChanged();
    });
  }
  commands.handle("canvas:link-add", (_event, a, b) => addLink(a, b));
  commands.handle("canvas:link-remove", (_event, id) => removeLink(id));
  const canvasChatModes = require("../canvas-chat-mode.cjs").createCanvasChatModes({
    registry: projectRegistry(),
    store: linkStore,
    scheduled: () => routines().list().routines,
    states,
    readProject,
    ownProject,
    chats,
    agents,
    broadcast: broadcastProjectState,
    changed: linksChanged,
    git,
  });
  commands.handle("canvas:chat-mode", (_event, id, mode) => canvasChatModes.change(id, mode));
  commands.handle("canvas:link-restore", async (_event, link) => {
    await projectRegistry().restoreLink(link, await canvasActiveWorktrees());
    return linksChanged();
  });
  const LINKS_PRUNE_MS = 5000;
  let linksPrune = { at: -Infinity, running: null };
  commands.handle("canvas:links", async () => {
    if (!linksPrune.running && Date.now() - linksPrune.at >= LINKS_PRUNE_MS) {
      const running = pruneLinks().finally(() => {
        linksPrune = { at: Date.now(), running: null };
      });
      linksPrune = { ...linksPrune, running };
    }
    await linksPrune.running;
    return canvasChatModes.describe((await projectRegistry().snapshot()).links);
  });
  commands.handle("linked:grant", (_event, chatId, linkId) => linked.grant(chatId, linkId));
  commands.handle("canvas:worktree-position", (_event, id, worktreePath, position) => projectRegistry().setWorktreePosition(id, worktreePath, position));
  commands.handle("canvas:open-project", async (_event, requested) => {
    if (chatsHome.isHome(requested) && (await chatsHome.exists())) return openProject(chatsHome.path, { remember: false, register: false });
    if (!(await projectRegistry().list()).some((project) => project.path === requested)) throw new Error("Project is not in the registry.");
    return openProject(requested);
  });
  return { addLink, removeLink, canvasChatModes };
}

function registerChatReads({
  commands,
  chats,
  chatsHome,
  openProject,
  projectName,
  projectsWithGit,
  projectRegistry,
  readProject,
  recentProjects,
  scopeStates,
  states,
  withKind,
}) {
  const listed = async (projectPath) =>
    (await recentProjects().list()).some((item) => item.path === projectPath) || (await projectRegistry().list()).some((item) => item.path === projectPath);
  commands.handle("project:read", async (_event, projectPath, read) => {
    const known = chatsHome.isHome(projectPath) ? await chatsHome.exists() : await listed(projectPath);
    if (!known) throw new Error("Open this project in Milagre first.");
    const project = withKind(await readProject(projectPath));
    if (read?.state !== false) return project;
    const { state: _state, ...rest } = project;
    return rest;
  });
  commands.handle("scope:retry-save", async (_event, scope) => {
    if (typeof scope !== "string" || !scopeStates.has(scope)) throw new Error("Open the Project or Link before retrying its save.");
    await scopeStates.retry(scope);
  });
  commands.handle("project:snapshot", async (_event, projectPath) => {
    if (!states.has(projectPath)) throw new Error("Open the project before reading its snapshot.");
    return withKind({ path: projectPath, name: projectName(projectPath), git: projectsWithGit.get(projectPath) ?? true, state: await states.get(projectPath) });
  });
  commands.handle("chat:message", async (_event, scope, id) => {
    if (typeof scope !== "string" || (!isLinkScopeKey(scope) && !states.has(scope))) throw new Error("Open the Project before reading its messages.");
    const message = await scopeStates.findMessage(scope, "id", id);
    if (!message) throw new Error("That message is no longer in this Project.");
    return withDetails(scopeStates.storageDirectory(scope), message);
  });
  const checkReadable = (scope) => {
    if (typeof scope !== "string" || (!isLinkScopeKey(scope) && !states.has(scope))) throw new Error("Open the Project before reading its messages.");
  };
  const readScope = async (scope) => {
    checkReadable(scope);
    return scopeStates.get(scope);
  };
  commands.handle("chat:all-messages", async (_event, scope, options) => {
    checkReadable(scope);
    const read = { withState: options?.withState === true };
    return options?.marks === true ? scopeStates.messageMarks(scope, read) : scopeStates.allMessages(scope, read);
  });
  commands.handle("chat:messages", async (_event, scope, chatId, options) => {
    if (typeof scope === "string" && !isLinkScopeKey(scope) && !states.has(scope) && Number.isSafeInteger(chatId) && existsSync(chatDbFile(scope))) {
      const known = chatsHome.isHome(scope) ? await chatsHome.exists() : (await recentProjects().list()).some((item) => item.path === scope);
      if (known && !states.has(scope))
        return chatPage(
          readChatRows(scope, [chatId]).map((row) => row.message),
          chatId,
          options ?? {},
        );
    }
    checkReadable(scope);
    return chatPage((await scopeStates.load(scope, [chatId])).messages, chatId, options ?? {});
  });
  commands.handle("chat:search", async (_event, scope, query, options) => {
    const state = await readScope(scope);
    const open = Object.values(state.sessions ?? {})
      .filter((session) => options?.archived === true || !session.archived)
      .map((session) => session.id);
    return chatSearch(state, query, options ?? {}, await scopeStates.searchableMessages(scope, open));
  });
  const knownProjects = async () => {
    const paths = [...(await recentProjects().list()), ...(await projectRegistry().list())].map((item) => item.path);
    if (await chatsHome.exists()) paths.push(chatsHome.path);
    return [...new Set(paths)];
  };
  const search = createChatSearch({
    scopeStates,
    knownProjects,
    nameOf: (scope) => (isLinkScopeKey(scope) ? "Link" : chatsHome.isHome(scope) ? "No project" : projectName(scope)),
  });
  commands.handle("chats:search", async (_event, query, options) => {
    const scope = typeof options?.scope === "string" && options.scope ? options.scope : undefined;
    if (scope && !scopeStates.has(scope) && (isLinkScopeKey(scope) || !(await knownProjects()).includes(scope)))
      throw new Error("Open the Project before searching its messages.");
    return search.search(query, { ...options, scope });
  });
  commands.handle("chat:subagent", async (_event, scope, chatId, agentId) => {
    const agent = (await readScope(scope)).sessions?.[chatId]?.subagents?.find((item) => item.id === agentId);
    if (!agent) throw new Error("That subagent is no longer in this Chat.");
    return loadSubagent(agent);
  });
  commands.handle("project:chat-image", (_event, projectPath, requested) => chats.images.resolve(projectPath, requested));
  commands.handle("project:worktree-paths", async (_event, projectPath) => {
    if (!states.has(projectPath)) throw new Error("Open the project before reading its worktrees.");
    return Object.values((await states.get(projectPath)).worktrees ?? {}).map((worktree) => worktree.path);
  });
  commands.handle("project:switch", async (_event, requested) => {
    if (chatsHome.isHome(requested) && (await chatsHome.exists())) return openProject(chatsHome.path, { remember: false, register: false });
    return openProject(await switchTarget(recentProjects(), requested));
  });
  commands.handle("chats:home", async () => ({ path: chatsHome.path, exists: await chatsHome.exists() }));
  commands.handle("chats:ensure", async () => openProject(await chatsHome.ensure(), { takeNotice: false, focus: false, remember: false, register: false }));
}

function registerProjectFinder({ options, dataDir, commands, chatsHome, projectSettings, recentProjects, localMcp, withHidden }) {
  const realDataDir = realpathSync(dataDir);
  const assertRegistrableProject = (folder) => {
    const relative = path.relative(realDataDir, folder);
    const insideDataDir = !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (chatsHome.isHome(folder) || insideDataDir) throw Error("That folder belongs to Milagre's internal state and cannot be registered as a Project.");
  };
  commands.handle("project:forget", async (_event, projectPath) => {
    localMcp().forgetProjectGrants(projectPath);
    return withHidden(await recentProjects().forget(projectPath));
  });
  const projectFinder = createProjectFinder(options.projectSearchRoot || require("node:os").homedir());
  commands.handle("project:find", (_event, query) => projectFinder.search(typeof query === "string" ? query.slice(0, 200) : ""));
  commands.handle("project:scan-children", async (_event, folder) => ({
    ...(await scanFolder(folder)),
    detect: (await projectSettings().getDetectRepositories()).detectRepositories,
  }));
  commands.handle("folder-repos:detect:read", () => projectSettings().getDetectRepositories());
  commands.handle("folder-repos:detect:save", (_event, value) => projectSettings().setDetectRepositories(value !== false));
  return { assertRegistrableProject };
}

function registerProjects({
  options,
  dataDir,
  commands,
  withoutHomes,
  agents,
  chats,
  broadcastProjectState,
  canvasActiveWorktrees,
  chatsHome,
  knownFolder,
  linkStore,
  linked,
  linksChanged,
  openProject,
  ownProject,
  projectName,
  projectRegistry,
  projectSettings,
  projectsWithGit,
  pruneLinks,
  readProject,
  recentProjects,
  scopeStates,
  states,
  withKind,
  git,
  routines,
  localMcp,
}) {
  const { withHidden, projectOrigin } = registerProjectLists({
    options,
    commands,
    withoutHomes,
    knownFolder,
    openProject,
    projectRegistry,
    projectSettings,
    recentProjects,
    git,
  });
  const { addLink, removeLink, canvasChatModes } = registerCanvas({
    commands,
    withoutHomes,
    agents,
    chats,
    broadcastProjectState,
    canvasActiveWorktrees,
    chatsHome,
    linkStore,
    linked,
    linksChanged,
    openProject,
    ownProject,
    projectRegistry,
    pruneLinks,
    readProject,
    recentProjects,
    states,
    git,
    routines,
    withHidden,
  });
  registerChatReads({
    commands,
    chats,
    chatsHome,
    openProject,
    projectName,
    projectsWithGit,
    projectRegistry,
    readProject,
    recentProjects,
    scopeStates,
    states,
    withKind,
  });
  const { assertRegistrableProject } = registerProjectFinder({ options, dataDir, commands, chatsHome, projectSettings, recentProjects, localMcp, withHidden });
  return { projectOrigin, addLink, removeLink, canvasChatModes, assertRegistrableProject };
}

module.exports = { registerProjects };

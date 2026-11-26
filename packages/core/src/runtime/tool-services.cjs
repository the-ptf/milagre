const path = require("node:path");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { createChatSimulators } = require("../chat-simulators.cjs");
const { providerName } = require("@milagre/shared/providers");

function createDeviceTools({ options, dataDir, emit, commands, existingChat, chatWorktrees, agents, scopeStates }) {
  const { createComputerUseSettings, createComputerUse, agentDesktopBinary, runCli } = require("../computer-use.cjs");
  const computerUseSettings = createComputerUseSettings({ file: path.join(dataDir, "computer-use.json"), emit });
  let desktopCli;
  const computerUseScreen = require("../computer-use-screen.cjs").createScreenFeed({
    exec: (args, runOptions) => runCli({ ...(desktopCli ??= agentDesktopBinary()), home: path.join(dataDir, "agent-desktop") }, args, runOptions),
    dir: path.join(dataDir, "computer-use", "frames"),
  });
  const computerUse =
    options.computerUse ??
    createComputerUse({
      dataDir,
      settings: computerUseSettings,
      approve: (chatId, request) => agents().askApproval(chatId, request),
      emit,
      onAction: ({ chatId, app, data }) => {
        void existingChat("capturing its screen")(chatId)
          .then(() => computerUseScreen.touch({ chatId, app, windowId: data?.window?.id, title: data?.window?.title }))
          .catch(() => {});
      },
    });
  const { createSimlockSettings, createSimlockHost } = require("../simlock.cjs");
  const simlockSettings = createSimlockSettings({ file: path.join(dataDir, "simlock.json"), emit });
  const simlock =
    options.simlock ??
    createSimlockHost({
      settings: simlockSettings,
      directory: path.join(dataDir, "simlock"),
      log: (message, fields) => console.warn(`Simlock: ${message}`, fields),
    });
  const { createBaguette, withBaguette } = require("../baguette.cjs");
  const baguette = options.baguette ?? createBaguette();
  const simulators = createChatSimulators({
    simulators:
      options.simulators ??
      require("../simulators.cjs").createSimulators({
        adapter: withBaguette(require("../simlock-channel.cjs").withSimlock(require("../simulators-helper.cjs").createSimulatorAdapter(), simlock), baguette),
      }),
    file: path.join(dataDir, "simulator-attachments.json"),
    validateChat: existingChat("attaching a simulator"),
    ended: (device) => simlock.isDevice(device.id),
  });
  for (const method of ["list", "attach", "detach"])
    commands.handle(`simulator:${method}`, async (context, request) => {
      if (!context?.clientId) throw new Error("Simulator access requires an authenticated connection");
      const lease = method === "detach" ? simlock.get(request?.deviceId) : null;
      if (lease && lease.chatId === request?.chatId) await simlock.release(lease.deviceId).catch(() => {});
      return simulators[method](request);
    });
  for (const method of ["open", "offer", "frame", "status", "control", "input", "repair", "close"]) {
    commands.handle(`simulator:${method}`, (context, request) => {
      if (!context?.clientId) throw new Error("Simulator access requires an authenticated connection");
      return simulators[method === "close" ? "closeViewer" : method](request, context.clientId);
    });
  }
  async function leaseSimlock(request) {
    const chatId = request?.chatId;
    await existingChat("leasing a Simlock device")(chatId);
    const roots = await chatWorktrees(chatId);
    const session = (await scopeStates().get(projectOfKey(chatId))).sessions[sessionIdFromKey(chatId)];
    const installDirectory = isLinkScopeKey(projectOfKey(chatId)) ? (session?.workspacePath ?? roots[0]?.path) : roots[0]?.path;
    if (!installDirectory) throw new Error("This Chat has no Worktree yet. Send it a message first, then lease a device.");
    const leased = await simlock.lease({ platform: request?.platform, model: request?.model || undefined, chatId, installDirectory });
    try {
      await simulators.attach({ chatId, deviceId: leased.deviceId });
    } catch (error) {
      await simlock.release(leased.deviceId).catch(() => {});
      throw error;
    }
    return leased;
  }
  async function releaseSimlock(request) {
    const lease = simlock.get(request?.deviceId);
    const released = await simlock.release(request?.deviceId);
    if (lease?.chatId) await simulators.detach({ chatId: lease.chatId, deviceId: lease.deviceId }).catch(() => {});
    return released;
  }
  commands.handle("computer-use:settings:read", () => computerUseSettings.read());
  commands.handle("computer-use:settings:save", (_context, patch) => computerUseSettings.save(patch));
  commands.handle("computer-use:status", () => computerUse.status());
  commands.handle("computer-use:guide", () => computerUse.guide());
  commands.handle("computer-use:frame", async (_context, request) => {
    await existingChat("viewing its screen")(request?.chatId);
    const frame = await computerUseScreen.next({ chatId: request.chatId, after: Number(request.after) || 0 });
    await existingChat("viewing its screen")(request.chatId);
    return frame;
  });
  commands.handle("baguette:status", () => baguette.detect());
  commands.handle("simlock:settings:read", () => simlockSettings.read());
  commands.handle("simlock:settings:save", (_context, patch) => simlockSettings.save(patch));
  commands.handle("simlock:identity", (_context, request) => simlock.identity(request ?? {}));
  commands.handle("simlock:models", async () => ({ models: await simlock.models(), leases: simlock.leases() }));
  commands.handle("simlock:lease", (context, request) => {
    if (!context?.clientId) throw new Error("Simlock access requires an authenticated connection");
    return leaseSimlock(request);
  });
  commands.handle("simlock:release", (context, request) => {
    if (!context?.clientId) throw new Error("Simlock access requires an authenticated connection");
    return releaseSimlock(request);
  });
  return { computerUseSettings, computerUseScreen, computerUse, simlockSettings, simlock, simulators, leaseSimlock, releaseSimlock };
}

function createDesignTools({ options, dataDir, emit, commands, existingChat, scopeStates }) {
  const { createChatArtifacts } = require("../chat-artifacts.cjs");
  const { createDesignKits, designKitToolDefinitions } = require("../design-kits.cjs");
  const { designKitReport } = require("../design-kit-report.cjs");
  const { createDesignLibrary, withDesignLibrary, designLibraryToolDefinitions } = require("../design-library.cjs");
  const designKits = createDesignKits({
    directory: path.join(dataDir, "design-kits"),
    projectForChat: async (chatId) => {
      await existingChat("using a design kit")(chatId);
      return projectOfKey(chatId);
    },
  });
  const artifacts = createChatArtifacts({
    directory: path.join(dataDir, "artifacts"),
    validateChat: existingChat("showing a design"),
    readKit: (request) => designKits.read(request),
    onChange: ({ chatId }) => designPageSharing().changed(chatId),
  });
  const designLibrary = createDesignLibrary({
    directory: path.join(dataDir, "design-library"),
    projectForChat: async (chatId) => {
      await existingChat("using the Project library")(chatId);
      return projectOfKey(chatId);
    },
    projectForPath: async (projectPath) => {
      if (!scopeStates().has(projectPath)) throw new Error("Open this project in Milagre first.");
      return projectPath;
    },
    chatInfo: async (chatId) => {
      const session = (await scopeStates().get(projectOfKey(chatId)))?.sessions[sessionIdFromKey(chatId)];
      return { title: session?.title || session?.generatedTitle, agent: session?.provider ? providerName(session.provider) : undefined };
    },
    artifacts,
    readKit: (request) => designKits.readProject(request),
    onChange: ({ project }) => emit("design-library:changed", { projectPath: project }),
  });
  const designs = withDesignLibrary(artifacts, designLibrary);
  commands.handle("design-library:list", (_context, request) => designLibrary.list(request));
  commands.handle("design-library:add", (_context, request) => designLibrary.add(request));
  commands.handle("design-library:update", (_context, request) => designLibrary.update(request));
  commands.handle("design-library:rename-page", (_context, request) => designLibrary.renamePage(request));
  let pageSharing;
  const designPageSharing = () =>
    (pageSharing ??= require("../design-page-sharing.cjs").createDesignPageSharing({
      directory: path.join(dataDir, "design-page-shares"),
      artifacts,
      validateChat: existingChat("sharing Designs"),
      chatTitle: async (chatId) => {
        const session = (await scopeStates().get(projectOfKey(chatId)))?.sessions[sessionIdFromKey(chatId)];
        return session?.title || session?.generatedTitle || null;
      },
      ...options.designSharing,
    }));
  commands.handle("artifact:page-shares", (_context, request) => designPageSharing().list(request));
  commands.handle("artifact:sharing-status", (_context, request) => designPageSharing().status(request));
  commands.handle("artifact:all-page-shares", () => designPageSharing().listAll());
  commands.handle("artifact:revoke-saved-page-share", (_context, request) => designPageSharing().revokeSaved(request));
  commands.handle("artifact:share-page", (_context, request) => designPageSharing().publish(request));
  commands.handle("artifact:revoke-page-share", (_context, request) => designPageSharing().revoke(request));
  commands.handle("artifact:set-page-share-paused", (_context, request) => designPageSharing().setPaused(request));
  setImmediate(() =>
    designPageSharing()
      .resumeStale()
      .catch((error) => console.warn("Milagre couldn't retry live page links:", error.message)),
  );
  commands.handle("designs:enabled:read", () => ({ enabled: true }));
  commands.handle("designs:enabled:save", () => ({ enabled: true }));
  commands.handle("artifact:get", (_context, request) => designs.get(request));
  commands.handle("artifact:asset", (_context, request) => artifacts.asset(request));
  commands.handle("artifact:list", (_context, request) => artifacts.list(request));
  commands.handle("artifact:delete", (_context, request) => designs.deleteDesign(request));
  commands.handle("artifact:add-comments", (_context, request) => artifacts.addComments(request));
  commands.handle("artifact:comments", (_context, request) => artifacts.comments(request));
  return {
    designKits,
    artifacts: designs,
    designToolDefinitions: (chatId) => [
      ...designKitToolDefinitions(chatId, designKits, {
        changed: (savedBy) => emit("design-library:changed", { projectPath: projectOfKey(savedBy), kit: true }),
        report: async (savedBy, kit) => {
          const project = projectOfKey(savedBy);
          const sessions = (await scopeStates().get(project))?.sessions ?? {};
          const chats = Object.keys(sessions).map((id) => `${project}#${id}`);
          return designKitReport({ kit, chatId: savedBy, chats, designs, library: designLibrary });
        },
      }),
      ...designLibraryToolDefinitions(chatId, designLibrary),
    ],
    closePageSharing: () => Promise.all([pageSharing?.close(), designLibrary.close()]),
  };
}

const PAGE_COMMENTS_PER_SEND = 50;

function pageCommentRequest(request) {
  const chatId = typeof request?.chatId === "string" ? request.chatId : "";
  const batch = Array.isArray(request?.comments) ? request.comments : null;
  if (batch && batch.length > PAGE_COMMENTS_PER_SEND) throw new Error(`Send at most ${PAGE_COMMENTS_PER_SEND} page comments at once.`);
  const items = (batch ?? [request]).map((item) => ({
    page: item?.page,
    text: typeof item?.text === "string" ? item.text.trim().slice(0, 4000) : "",
  }));
  const point = [request?.x, request?.y];
  if (!chatId || !items.length || items.some((item) => !item.text)) throw new Error("Write the comment first.");
  if (batch && items.some((item) => !item.page)) throw new Error("Tap an element on the page before sending a comment.");
  if (!batch && !request.page && !point.every((value) => typeof value === "number" && value >= 0 && value <= 1))
    throw new Error("Tap the page to place a comment pin.");
  return { chatId, batch, items, point };
}

function createPageComments({ dataDir, commands, existingChat, scopeStates, chats, agents, browsers, sendAsUser }) {
  const { commentAtPoint, createChatPageComments, pageElement } = require("../chat-page-comments.cjs");
  const pageComments = createChatPageComments({
    directory: path.join(dataDir, "page-comments"),
    validateChat: existingChat("commenting on a page"),
  });
  commands.handle("browser-comments:add", (_context, request) => pageComments.add(request));
  commands.handle("browser-comments:list", (_context, request) => pageComments.list(request));
  commands.handle("browser-comments:send-from-page", async (_context, request) => {
    const { chatId, batch, items, point } = pageCommentRequest(request);
    const scope = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    const session = scope && Number.isSafeInteger(sessionId) ? (await scopeStates().get(scope))?.sessions?.[sessionId] : null;
    if (!session) throw new Error("Open an existing Chat before commenting on a page.");
    const { pageCommentId, pageCommentsMessage } = await import("@milagre/shared/page-comments");
    const comments = [];
    let shot = null;
    for (const item of items) {
      const local = item.page;
      const remote = local ? null : await browsers().devtools({ chatId, page: typeof request.targetId === "string" ? request.targetId : undefined });
      const target = local ? { url: String(local.url ?? "").slice(0, 2000), title: String(local.title ?? "").slice(0, 200) } : remote.target;
      const read = local ? { element: pageElement(local.element), shot: null } : await commentAtPoint(remote.session, point[0], point[1]);
      if (!read.element) throw new Error("Tap an element on the page before sending a comment.");
      shot = read.shot;
      comments.push({ id: pageCommentId(), url: target.url, title: target.title, element: read.element, text: item.text });
    }
    await pageComments.add({ chatId, comments });
    const settings = chats().turnSettings(chatId) ?? {};
    try {
      await sendAsUser({
        ...settings,
        provider: session.provider ?? settings.provider ?? "claude",
        model: chats().runs[chatId]?.model || require("@milagre/shared/agent-runs").lastUserModel(await scopeStates().get(scope), sessionId) || settings.model,
        permissionMode: agents().permissionMode(chatId, settings.permissionMode ?? session.permissionMode ?? "ask"),
        projectPath: scope,
        sessionId,
        body: pageCommentsMessage(comments, { screenshots: !!shot }),
        images: shot ? [{ id: `page-comment-${comments[0].id}`, name: `page-comment-${comments[0].id}.png`, dataUrl: `data:image/png;base64,${shot}` }] : [],
        files: [],
      });
    } catch (error) {
      await pageComments.forget({ chatId, ids: comments.map((comment) => comment.id) }).catch(() => {});
      throw error;
    }
    return batch ? { ids: comments.map((comment) => comment.id) } : { id: comments[0].id };
  });
  return { pageComments };
}

function createBrowserTools({ options, emit, commands, agents, advisors }) {
  function agentProcesses() {
    const roots = agents().processes();
    for (const [chatId, root] of roots) root.active = agents().isTurnActive(chatId) || agents().backgroundWork(chatId) > 0;
    for (const [chatId, children] of advisors()?.processes() ?? []) {
      roots.set(chatId, { cwd: children[0].cwd, ...roots.get(chatId), agents: children.map((child) => child.pid), active: true });
    }
    return roots;
  }
  const browsers = options.browsers ?? require("../browsers.cjs").createBrowsers({ roots: agentProcesses });
  commands.handle("browser:list", (_context, request) => browsers.list(request));
  commands.handle("browser:attach", (_context, request) => browsers.attach(request));
  commands.handle("browser:detach", (_context, request) => browsers.detach(request));
  commands.handle("browser:open-page", (context, request) => {
    if (!context?.clientId) throw new Error("Browser access requires an authenticated connection");
    return require("../browser-open-page.cjs").openBrowserPage(browsers, (chatId, url) => emit("browser-panel:open", { chatId, url }), request);
  });
  const panelForwarders = require("../panel-forwarders.cjs").createPanelForwarders();
  commands.handle("browser:panel-pages", async (context, request) => {
    if (!context?.clientId) throw new Error("Browser panel pages need an authenticated desktop connection");
    if (request?.via !== "peer") return browsers.setPanelPages(request, context.clientId);
    if (typeof context.openStream !== "function") throw new Error("Only a paired desktop's channel carries its Browser pages.");
    if (!Array.isArray(request.pages) || !request.pages.length) {
      await panelForwarders.close(context.clientId);
      return browsers.setPanelPages({ pages: [] }, context.clientId);
    }
    const port = await panelForwarders.forward(context.clientId, context.openStream, request.port);
    return browsers.setPanelPages({ port, prefix: request.prefix, pages: request.pages, remote: true }, context.clientId);
  });
  for (const method of ["open", "frame", "status", "control", "input", "close"]) {
    commands.handle(`browser:${method}`, (context, request) => {
      if (!context?.clientId) throw new Error("Browser access requires an authenticated connection");
      return browsers[method === "close" ? "closeViewer" : method](request, context.clientId);
    });
  }
  return { agentProcesses, browsers, panelForwarders };
}

function createToolServices({ options, dataDir, emit, commands, existingChat, agents, scopeStates, chats, ports, advisors, sendAsUser }) {
  async function chatWorktrees(chatId) {
    const scope = projectOfKey(chatId),
      id = sessionIdFromKey(chatId);
    if (!scope || !Number.isSafeInteger(id) || id < 1 || !scopeStates().has(scope)) throw new Error("Open this Chat before opening a Terminal.");
    const state = await scopeStates().get(scope);
    const session = state.sessions[id];
    if (!session) throw new Error("Open an existing Chat before opening a Terminal.");
    if (session.archived) throw new Error("This Chat is archived.");
    if (isLinkScopeKey(scope)) {
      const worktrees = (session.worktrees ?? []).map((member) => ({ path: member.worktreePath, label: member.alias }));
      return worktrees.length ? worktrees : session.workspacePath ? [{ path: session.workspacePath, label: "Workspace" }] : [];
    }
    const worktree = state.worktrees?.[session.worktree_id];
    return worktree?.path ? [{ path: worktree.path, label: path.basename(worktree.path) }] : [];
  }
  const devices = createDeviceTools({ options, dataDir, emit, commands, existingChat, chatWorktrees, agents, scopeStates });
  const design = createDesignTools({ options, dataDir, emit, commands, existingChat, scopeStates });
  const { pageComments } = createPageComments({
    dataDir,
    commands,
    existingChat,
    scopeStates,
    chats,
    agents,
    browsers: () => browserTools.browsers,
    sendAsUser,
  });
  const browserTools = createBrowserTools({ options, emit, commands, agents, advisors });
  const terminals =
    options.terminals ??
    require("../terminals.cjs").createTerminals({
      resolveChat: chatWorktrees,
      settingsFile: path.join(dataDir, "terminal-settings.json"),
      onChange: (chatId) => emit("terminal:changed", { chatId }),
      onPreferencesChanged: () => emit("terminal:preferences-changed", {}),
      onShellsChanged: () => ports().wake(),
    });
  commands.handle("terminal:list", (_context, request) => terminals.list(request));
  for (const method of ["profiles", "setShell", "open", "read", "input", "resize", "close"]) {
    commands.handle(`terminal:${method}`, (context, request) => {
      if (!context?.clientId) throw new Error("Terminal access requires an authenticated connection");
      return terminals[method](request);
    });
  }
  const close = () =>
    Promise.all([
      devices.simulators.close(),
      browserTools.browsers.close(),
      browserTools.panelForwarders.closeAll(),
      design.artifacts.close(),
      design.designKits.close(),
      design.closePageSharing(),
      pageComments.close(),
      terminals.dispose(),
    ]);
  return { ...devices, ...design, pageComments, ...browserTools, chatWorktrees, terminals, close };
}

module.exports = { createToolServices };

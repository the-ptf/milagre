const { isLinkScopeKey, scopeFromKey, computerOfKey, LOCAL_COMPUTER } = require("@milagre/shared/chat-scopes");
const path = require("node:path");
const { chatKey, lastUserModel, projectOfKey, runStatus, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { activeWorktrees } = require("./project-identity.cjs");
const { linkedWorktrees } = require("./project-links.cjs");
const { Delegations, jsonFileStore } = require("./delegations.cjs");
const { callerMode, modeRank } = require("./agents/permissions.cjs");
const { chatLabel, createLinkedReads, delegationReply, linkedToolDefinitions } = require("./linked-tools.cjs");
const { chatTitle } = require("@milagre/shared/chats");
const { createLinkedMcpServer } = require("./linked-mcp-server.cjs");
const { worktreeLinkText } = require("@milagre/shared/worktree-link");

const NO_COMPUTERS = "none. Pair one and turn on Drive other computers in Settings > Phone & sharing.";
const ACTIVE_TTL_MS = 3000;

function createLinkedWorktrees({
  dataDir,
  registry,
  linkProjects = async () => [],
  grantedProjects = () => [],
  project,
  messages = async (projectPath, chatIds) => {
    const all = (await project(projectPath)).messages;
    return chatIds ? all.filter((message) => chatIds.includes(message.session_id)) : all;
  },
  bodies = messages,
  chats,
  agents,
  emit,
  pendingAdvisorResults = async () => false,
  extraTools = () => [],
  chatTools = (_chatId, tools) => tools,
  remote = null,
  createWorktree = async () => {
    throw new Error("This computer can't make Worktrees for a Delegation.");
  },
  createMcpServer = createLinkedMcpServer,
  store = jsonFileStore(path.join(dataDir, "delegations.json")),
}) {
  // Codex Chats whose provider refused the linked tools: they get the summary and receive Delegations only.
  const receiveOnly = new Set();
  const tools = new Map();
  const activeCache = new Map();

  function active(projectPath) {
    const cached = activeCache.get(projectPath);
    if (cached && Date.now() - cached.at < ACTIVE_TTL_MS) return cached.paths;
    const paths = activeWorktrees(projectPath).then(
      (worktrees) => worktrees.map((worktree) => worktree.path),
      () => [],
    );
    activeCache.set(projectPath, { at: Date.now(), paths });
    return paths;
  }

  async function sides(chatId) {
    const projectPath = projectOfKey(chatId);
    const { projects, links } = await registry().snapshot();
    const state = await project(projectPath);
    const session = state.sessions[sessionIdFromKey(chatId)];
    const ownBindings = isLinkScopeKey(projectPath)
      ? (session?.worktrees ?? [])
      : [{ projectId: projects.find((entry) => entry.path === projectPath)?.id, worktreePath: state.worktrees[session?.worktree_id]?.path }];
    const owned = new Set(ownBindings.map((member) => member.worktreePath));
    const found = new Map();
    for (const member of ownBindings) {
      const source = projects.find((entry) => entry.id === member.projectId);
      if (!source || !member.worktreePath) continue;
      const relevant = links.filter((link) => link.a.project_id === source.id || link.b.project_id === source.id);
      if (!relevant.length) continue;
      const ids = new Set([source.id, ...relevant.flatMap((link) => [link.a.project_id, link.b.project_id])]);
      const reach = Object.fromEntries(
        await Promise.all(
          [...ids].map(async (id) => {
            const entry = projects.find((item) => item.id === id);
            return [id, entry ? await active(entry.path) : []];
          }),
        ),
      );
      for (const item of linkedWorktrees({ project_id: source.id, worktree_path: member.worktreePath }, relevant, reach)) {
        if (owned.has(item.worktree_path)) continue;
        const entry = projects.find((candidate) => candidate.id === item.project_id);
        const key = `${item.project_id}\0${item.worktree_path}`;
        if (!found.has(key)) found.set(key, { ...item, projectPath: entry.path, projectName: entry.name, sourceWorktree: member.worktreePath });
      }
    }
    return [...found.values()];
  }

  async function ownWorktree(chatId, worktreePath) {
    const scope = projectOfKey(chatId);
    const { projects } = await registry().snapshot();
    const base = isLinkScopeKey(scope)
      ? await linkProjects(scopeFromKey(scope).linkId)
      : [projects.find((item) => item.path === scope) ?? { path: scope, name: path.basename(scope) }];
    const extra = (await grantedProjects(chatId))
      .filter((projectPath) => !base.some((item) => item.path === projectPath))
      .map((projectPath) => projects.find((item) => item.path === projectPath))
      .filter(Boolean);
    for (const candidate of [...base, ...extra]) {
      const state = await project(candidate.path);
      const worktree = Object.values(state.worktrees).find((item) => item.path === worktreePath);
      if (!worktree || !(await active(candidate.path)).includes(worktreePath)) continue;
      if (worktree.sharedChat) throw new Error("Delegation into a shared Link Chat is not supported. Read its canonical transcript instead.");
      return {
        link_id: null,
        link_ids: [],
        projectPath: candidate.path,
        projectName: candidate.name ?? path.basename(candidate.path),
        branch: worktree.name ?? path.basename(worktreePath),
      };
    }
    return null;
  }

  async function hostTarget(worktreePath) {
    if (typeof worktreePath !== "string" || !path.isAbsolute(worktreePath)) return null;
    const { projects } = await registry().snapshot();
    for (const candidate of projects) {
      if (candidate.hidden || !(await active(candidate.path)).includes(worktreePath)) continue;
      const state = await project(candidate.path);
      const worktree = Object.values(state.worktrees).find((item) => item.path === worktreePath);
      if (!worktree) continue;
      if (worktree.sharedChat) throw new Error("Delegation into a shared Link Chat is not supported.");
      return {
        projectPath: candidate.path,
        projectName: candidate.name ?? path.basename(candidate.path),
        branch: worktree.name ?? path.basename(worktreePath),
      };
    }
    return null;
  }

  async function hostProject(projectPath) {
    if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) return null;
    const { projects } = await registry().snapshot();
    const found = projects.find((candidate) => !candidate.hidden && candidate.path === projectPath);
    return found ? { projectPath: found.path, projectName: found.name ?? path.basename(found.path) } : null;
  }

  async function hostTargets() {
    const { projects } = await registry().snapshot();
    return Promise.all(
      projects
        .filter((candidate) => !candidate.hidden)
        .map(async (candidate) => ({
          name: candidate.name ?? path.basename(candidate.path),
          path: candidate.path,
          worktrees: (await activeWorktrees(candidate.path).catch(() => [])).map((worktree) => ({
            path: worktree.path,
            branch: worktree.branch ?? worktree.name ?? path.basename(worktree.path),
          })),
        })),
    );
  }

  async function remoteOverview() {
    if (!remote?.enabled()) return "";
    const computers = remote.list();
    if (!computers.length) return `Other computers: ${NO_COMPUTERS}`;
    const sections = await Promise.all(
      computers.map(async (computer) => {
        if (!computer.online) return `- ${computer.name}: offline, can't take Delegations now`;
        try {
          const projects = await remote.invoke(computer.id, "delegation:targets", []);
          const lines = (Array.isArray(projects) ? projects : []).flatMap((item) =>
            (item.worktrees ?? []).map((worktree) => `  - ${item.name} / ${worktree.branch}: worktree ${worktree.path}`),
          );
          return [`- ${computer.name}:`, ...(lines.length ? lines : ["  (no Projects)"])].join("\n");
        } catch (error) {
          return `- ${computer.name}: couldn't list its Projects (${error.message})`;
        }
      }),
    );
    return ['Other computers (delegate with `computer` set to the name, and a Chat ref or "new"):', ...sections].join("\n");
  }

  const reads = createLinkedReads({
    sides,
    state: project,
    messages,
    bodies,
    runs: () => chats.runs,
    receiveOnly: (key) => receiveOnly.has(key),
    open: (side) => delegations.openBetween(side.sourceWorktree, side.worktree_path),
  });

  async function chat(key) {
    const projectPath = projectOfKey(key);
    const state = await project(projectPath).catch(() => null);
    const session = state?.sessions[sessionIdFromKey(key)];
    if (!session) return null;
    if (isLinkScopeKey(projectPath)) {
      const linkId = scopeFromKey(projectPath).linkId;
      const link = (await registry().listProjectGroups()).find((item) => item.id === linkId);
      const messages = state.messages.filter((message) => message.session_id === session.id);
      return { label: `${link?.name ?? "Link"} / ${chatTitle(session, messages)}`, worktreePath: session.workspacePath, archived: Boolean(session.archived) };
    }
    return {
      label: chatLabel(path.basename(projectPath), state, session.id),
      worktreePath: state.worktrees[session.worktree_id]?.path,
      archived: Boolean(session.archived),
      ...(session.readOnlyReason ? { readOnlyReason: session.readOnlyReason } : {}),
    };
  }

  function turnOptions(key, state, requester, mode) {
    const latest = chats.turnSettings(key);
    if (latest) return latest;
    const session = state.sessions[sessionIdFromKey(key)];
    const lastUsed = state.messages.findLast((message) => message.role === "user" && message.model && state.sessions[message.session_id]?.provider);
    const fallback = chats.turnSettings(requester) ?? {};
    return {
      provider: session?.provider ?? (lastUsed ? state.sessions[lastUsed.session_id].provider : (fallback.provider ?? "claude")),
      model: lastUserModel(state, session.id) || lastUsed?.model || fallback.model,
      permissionMode: callerMode(mode ?? agents.permissionMode(requester)),
      tldrEnabled: fallback.tldrEnabled,
      replies: fallback.replies,
    };
  }

  function deliveryMode(key, requester) {
    const modes = [agents.permissionMode(key, null), chats.turnSettings(key)?.permissionMode].filter(Boolean);
    return modes.length ? modes.reduce((most, mode) => (modeRank(mode) > modeRank(most) ? mode : most)) : callerMode(agents.permissionMode(requester));
  }

  async function deliver(key, { body, prompt, context, mode }) {
    const projectPath = projectOfKey(key);
    let state = await project(projectPath);
    const session = state.sessions[sessionIdFromKey(key)];
    if (!session) throw new Error("that Chat is no longer in its Project");
    if (!chats.turnSettings(key)) state = { ...state, messages: await messages(projectPath) };
    const { started, queued } = await chats.send({
      body,
      prompt,
      context,
      images: [],
      files: [],
      ...turnOptions(key, state, context.from, mode),
      projectPath,
      sessionId: session.id,
      worktreeId: session.worktree_id,
    });
    return { started, queued: Boolean(queued) };
  }

  function setToolsAvailable(chatId, available) {
    if (available === !receiveOnly.has(chatId)) return;
    if (available) receiveOnly.delete(chatId);
    else receiveOnly.add(chatId);
    emit("linked:changed", snapshot());
  }

  const snapshot = () => ({ ...delegations.snapshot(), receiveOnly: [...receiveOnly] });

  const delegations = new Delegations({
    store,
    ports: {
      async target(fromChat, worktreePath) {
        const own = await ownWorktree(fromChat, worktreePath);
        if (own) return own;
        const side = (await sides(fromChat)).find((item) => item.worktree_path === worktreePath);
        if (!side) return null;
        const state = await project(side.projectPath);
        const worktree = Object.values(state.worktrees).find((item) => item.path === worktreePath);
        if (worktree?.sharedChat) throw new Error("Delegation into a shared Link Chat is not supported. Read its canonical transcript instead.");
        return {
          link_id: side.link_id,
          link_ids: side.link_ids ?? [side.link_id],
          projectPath: side.projectPath,
          projectName: side.projectName,
          branch: worktree?.name ?? path.basename(worktreePath),
        };
      },
      chat,
      async openChat(projectPath, worktreePath) {
        const state = await project(projectPath);
        const worktree = Object.values(state.worktrees).find((item) => item.path === worktreePath);
        if (!worktree) throw new Error("That Worktree is no longer in its Project.");
        return chatKey(projectPath, await chats.emptyChat(projectPath, worktree.id));
      },
      adoptSubchat: (toChat, fromChat) => chats.adoptSubchat(toChat, fromChat),
      detachSubchat: async (chat, parent) => computerOfKey(chat) === LOCAL_COMPUTER && chats.detachSubchat(chat, parent),
      status: (key) => runStatus(chats.runs[key]),
      pendingResults: async (key) => {
        const session = (await project(projectOfKey(key))).sessions[sessionIdFromKey(key)];
        return Boolean(
          chats.runs[key] ||
          chats.startingTurns?.has(key) ||
          session?.queued?.some((entry) => entry.context?.kind === "advisor-result") ||
          (await pendingAdvisorResults(key)),
        );
      },
      deliver,
      note: (key, note) => chats.addNote(key, note),
      reply: async (key, delegationId) => delegationReply(await messages(projectOfKey(key), [sessionIdFromKey(key)]), sessionIdFromKey(key), delegationId),
      permissionMode: (key) => agents.permissionMode(key),
      deliveryMode: (key, requester) => deliveryMode(key, requester),
      approve: (key, request) => agents.askApproval(key, request),
      changed: () => emit("linked:changed", snapshot()),
      remote,
      hostTarget,
      hostProject,
      newWorktree: async (projectPath, prompt) => {
        const made = await createWorktree(projectPath, prompt);
        activeCache.delete(projectPath);
        return made;
      },
      remoteReport: (report) => emit("delegation:report", report),
    },
  });

  const mcp = createMcpServer({ toolsFor });

  async function linkAdded(link, reach) {
    const { projects } = await registry().snapshot();
    const byId = new Map(projects.map((entry) => [entry.id, entry]));
    for (const endpoint of [link.a, link.b]) {
      const source = byId.get(endpoint.project_id);
      if (!source) continue;
      const state = await project(source.path);
      const paths = endpoint.worktree_path === undefined ? (reach[source.id] ?? []) : [endpoint.worktree_path];
      for (const worktreePath of paths) {
        const reached = linkedWorktrees({ project_id: source.id, worktree_path: worktreePath }, [link], reach);
        const target = reached.length ? byId.get(reached[0].project_id) : null;
        const worktree = Object.values(state.worktrees ?? {}).find((item) => item.path === worktreePath);
        if (!target || !worktree) continue;
        const targetState = target.path === source.path ? state : await project(target.path);
        const branches = reached.map(
          (item) =>
            Object.values(targetState.worktrees ?? {}).find((candidate) => candidate.path === item.worktree_path)?.name ?? path.basename(item.worktree_path),
        );
        for (const session of Object.values(state.sessions)) {
          if (session.worktree_id !== worktree.id || session.archived || session.readOnlyReason) continue;
          if (!((session.summary?.count ?? 0) > 0 || state.messages.some((message) => message.session_id === session.id))) continue;
          const key = chatKey(source.path, session.id);
          const summary = await reads.summary(key).catch(() => "");
          const context = {
            kind: "worktree-linked",
            linkId: link.id,
            project: { name: target.name, path: target.path },
            sameProject: target.path === source.path,
            branches,
            ...(summary ? { summary } : {}),
          };
          await chats.addNote(key, { body: worktreeLinkText(context), context });
        }
      }
    }
  }

  function toolsFor(chatId) {
    if (!tools.has(chatId))
      tools.set(
        chatId,
        linkedToolDefinitions(chatId, {
          reads: {
            ...reads,
            overview: async (key) => [await reads.overview(key), await remoteOverview()].filter(Boolean).join("\n\n"),
          },
          delegations: isLinkScopeKey(projectOfKey(chatId))
            ? {
                delegate: async (fromChat, args) => {
                  if (args.negotiation) throw new Error("Shared Link Chats do not host Negotiations. Send a Delegation instead.");
                  return delegations.delegate(fromChat, args);
                },
                conclude: async () => {
                  throw new Error("Shared Link Chats do not host Negotiations.");
                },
                detach: (chat, by) => delegations.detach(chat, by),
              }
            : delegations,
        }),
      );
    return chatTools(chatId, [...tools.get(chatId), ...extraTools(chatId)]);
  }

  return {
    /** What a new agent session of the Chat gets: its tools, the MCP endpoint Codex reaches them at, and a way to say whether Codex took them. */
    forChat: (chatId) => ({
      tools: toolsFor(chatId),
      url: () => mcp.url(chatId),
      toolsAvailable: (available) => setToolsAvailable(chatId, available),
    }),
    context: (chatId) => reads.summary(chatId).catch(() => ""),
    reportsForTurn: (chatId) =>
      delegations.reportsForTurn(chatId).catch((error) => {
        console.warn("Milagre couldn't read the Delegation reports:", error.message);
        return null;
      }),
    observe: (chatId, event) => delegations.observe(chatId, event),
    queuedStarted: (chatId, context, started) => delegations.adopt(chatId, context, started),
    queuedRemoved: (chatId, context) => delegations.unqueued(chatId, context),
    linkAdded,
    linkRemoved: (id) => delegations.linkRemoved(id),
    async grant(chatId, linkId) {
      if (typeof chatId !== "string" || !chatId.includes("#")) throw new Error("Choose a Chat and a Link.");
      if (!(await registry().snapshot()).links.some((link) => link.id === linkId)) throw new Error("That Link no longer exists.");
      if (isLinkScopeKey(projectOfKey(chatId))) throw new Error("A shared Link Chat makes no Delegations.");
      await delegations.grant(chatId, linkId);
    },
    stop: (target) => delegations.stop(target),
    detach: (chatId) => delegations.detach(chatId),
    snapshot,
    hosted: {
      targets: hostTargets,
      prepare: async (request) => {
        const { label, raisedMode } = await delegations.prepareHosted(request);
        return { label, raisedMode };
      },
      receive: (request) => delegations.receiveHosted(request),
      reports: (request) => delegations.hostedReports(request),
      collected: (request) => delegations.collectedHosted(request),
    },
    remoteFinished: (computerId, report) => delegations.remoteFinished(computerId, report),
    catchUp: (computerId) => delegations.catchUp(computerId),
    computerRemoved: (computerId) => delegations.computerRemoved(computerId),
    suspend: () => delegations.suspend(),
    close: async () => {
      await mcp.close();
      await delegations.idle();
    },
  };
}

module.exports = { createLinkedWorktrees };

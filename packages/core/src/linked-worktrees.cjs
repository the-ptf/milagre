const { isLinkScopeKey, scopeFromKey } = require("@milagre/shared/chat-scopes");
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

const NO_COMPUTERS = "none. Pair one and turn on Drive other computers in Settings > Devices.";
// Every turn and tool call of a linked Chat asks which Worktrees are active; git is asked again after this long.
const ACTIVE_TTL_MS = 3000;

/**
 * What a Chat gets from its Links (spec 003): the summary at the start of each turn, the linked tools for
 * either provider, and the Delegations they make. The runtime supplies its parts:
 *   registry() -> the Project registry; linkProjects(linkId) -> a named Link's member Projects, { id, name, path }
 *   project(path) -> the Project's state, loading the Project if needed (it can
 *   leave out unloaded Chats' messages: see message-store.cjs); messages(path, chatIds) -> those Chats' messages, whole,
 *   or every message without chatIds; bodies(path, chatIds) -> their ids, roles and bodies
 *   chats -> the ChatHost; agents -> the SessionManager; emit(channel, payload) -> the windows
 *   chatTools(chatId, tools) -> the tools a Chat keeps of all it would get (Bot rules withhold most of Milagre's)
 *   botOf(chatId) -> the name of the bot that runs a Chat (its thread, or a Chat it opened the user hasn't taken over)
 *   remote -> the paired computers a Chat can delegate to (see Delegations' `remote` port), or null
 */
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
  botOf = () => null,
  remote = null,
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

  /** The Worktrees a Chat can see, each with the Link that reaches it and the Chat's own Worktree. */
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

  /**
   * An active Worktree of the Chat's own Project (or a Project granted to this Chat) as a Delegation target, with no
   * Link, or null. A shared Link Chat's own Projects are its Link's members; its own Worktrees there belong to it alone
   * (ADR-0005), so they are refused.
   */
  async function ownWorktree(chatId, worktreePath) {
    const scope = projectOfKey(chatId);
    const { projects } = await registry().snapshot();
    const base = isLinkScopeKey(scope)
      ? await linkProjects(scopeFromKey(scope).linkId)
      : [projects.find((item) => item.path === scope) ?? { path: scope, name: path.basename(scope) }];
    const extra = botOf(chatId)
      ? []
      : (await grantedProjects(chatId))
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

  /**
   * An active Worktree of any Project on this computer, as a Delegation from another computer's target, or null. Only
   * Projects in the registry are looked at (never a bot's home, ADR-0010), and only the one whose Worktree it is loads.
   */
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

  /** What another computer's Chats can delegate to here: each Project in the registry with its active Worktrees. */
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

  /** The paired computers' Projects for linked_overview, while delegating to them is on; "" when it is off. */
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
    // A shared Link Chat is named by its Link and works from its workspace folder, not from one Project's Worktree.
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
    };
  }

  // A delivered message runs on the receiving Chat's latest turn settings. A Chat with none this run takes
  // its own provider and model, else the Project's last used, else the requesting Chat's; its permission
  // mode is the requesting Chat's, until the user picks one there.
  function turnOptions(key, state, requester, mode) {
    const latest = chats.turnSettings(key);
    if (latest) return latest;
    const session = state.sessions[sessionIdFromKey(key)];
    const lastUsed = state.messages.findLast((message) => message.role === "user" && message.model && state.sessions[message.session_id]?.provider);
    const fallback = chats.turnSettings(requester) ?? {};
    return {
      provider: session?.provider ?? (lastUsed ? state.sessions[lastUsed.session_id].provider : (fallback.provider ?? "claude")),
      model: lastUserModel(state, session.id) || lastUsed?.model || fallback.model,
      // A Delegation from another computer has no requester here; it brings its caller's mode (`mode`).
      permissionMode: callerMode(mode ?? agents.permissionMode(requester)),
      tldrEnabled: fallback.tldrEnabled,
      replies: fallback.replies,
    };
  }

  // The mode a delivered message runs in: the latest turn's (turnOptions), or the live agent's when a steer reaches it
  // after a switch, whichever allows more (Bot rules most: see modeRank); a Chat with neither takes the requesting Chat's.
  function deliveryMode(key, requester) {
    const modes = [agents.permissionMode(key, null), chats.turnSettings(key)?.permissionMode].filter(Boolean);
    return modes.length ? modes.reduce((most, mode) => (modeRank(mode) > modeRank(most) ? mode : most)) : callerMode(agents.permissionMode(requester));
  }

  // Resolves once the message is saved, with `started`: what took it (see Delegations' deliver port), and `queued` when
  // it waits in the Chat's queue for a turn its provider can't steer.
  async function deliver(key, { body, prompt, context, mode }) {
    const projectPath = projectOfKey(key);
    let state = await project(projectPath);
    const session = state.sessions[sessionIdFromKey(key)];
    if (!session) throw new Error("that Chat is no longer in its Project");
    const bot = botOf(key);
    if (bot) throw new Error(`${bot} runs that Chat, and only ${bot} steers it`);
    // The Project's last used model is read across every Chat, unloaded ones too, when the Chat has no turn this run.
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
        // A Worktree of the Chat's own Project needs no Link: its agent can already start Chats there.
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
      botOf: (key) => botOf(key),
      deliveryMode: (key, requester) => deliveryMode(key, requester),
      approve: (key, request) => agents.askApproval(key, request),
      changed: () => emit("linked:changed", snapshot()),
      remote,
      hostTarget,
      // Every client hears it; the computer that asked (a paired desktop's daemon) takes its own (remoteFinished).
      remoteReport: (report) => emit("delegation:report", report),
    },
  });

  const mcp = createMcpServer({ toolsFor });

  /**
   * A line in every Chat a new Link reaches, written when the Link is made: the Worktrees it now sees, and the linked
   * summary its next turn gets. `reach` is each Project's active Worktree paths, by Project id. Archived Chats and
   * Chats without messages get none (an empty Chat is the one a Worktree reuses for its next send).
   */
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
          if (session.worktree_id !== worktree.id || session.archived) continue;
          // An unloaded Chat's messages aren't in the state: its summary counts them.
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
          // The paired computers a Chat can delegate to follow its own Links.
          reads: {
            ...reads,
            overview: async (key) => [await reads.overview(key), await remoteOverview()].filter(Boolean).join("\n\n"),
          },
          // A shared Link Chat delegates like any Chat (to its Link's Projects, or along a canvas Link), but hosts no
          // Negotiation: its other side would be a shared transcript several Projects write to.
          delegations: isLinkScopeKey(projectOfKey(chatId))
            ? {
                delegate: async (fromChat, args) => {
                  if (args.negotiation) throw new Error("Shared Link Chats do not host Negotiations. Send a Delegation instead.");
                  return delegations.delegate(fromChat, args);
                },
                conclude: async () => {
                  throw new Error("Shared Link Chats do not host Negotiations.");
                },
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
    /** The linked summary can be read while CLI and setup checks run; it consumes nothing. */
    context: (chatId) => reads.summary(chatId).catch(() => ""),
    reportsForTurn: (chatId) =>
      delegations.reportsForTurn(chatId).catch((error) => {
        console.warn("Milagre couldn't read the Delegation reports:", error.message);
        return null;
      }),
    observe: (chatId, event) => delegations.observe(chatId, event),
    /** A Delegation (or Negotiation report) that waited in the Chat's queue across a restart started, or was removed. */
    queuedStarted: (chatId, context, started) => delegations.adopt(chatId, context, started),
    queuedRemoved: (chatId, context) => delegations.unqueued(chatId, context),
    linkAdded,
    linkRemoved: (id) => delegations.linkRemoved(id),
    /** "Always allow Delegations" from the sidebar's Link popover: the grant the approval card saves, set ahead. */
    async grant(chatId, linkId) {
      if (typeof chatId !== "string" || !chatId.includes("#")) throw new Error("Choose a Chat and a Link.");
      if (!(await registry().snapshot()).links.some((link) => link.id === linkId)) throw new Error("That Link no longer exists.");
      if (isLinkScopeKey(projectOfKey(chatId))) throw new Error("A shared Link Chat makes no Delegations.");
      await delegations.grant(chatId, linkId);
    },
    stop: (target) => delegations.stop(target),
    snapshot,
    // Delegations between computers (spec 2026-10-23): this Mac running another computer's (hosted), and this Mac's
    // Chats hearing back from the computers they delegated to.
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

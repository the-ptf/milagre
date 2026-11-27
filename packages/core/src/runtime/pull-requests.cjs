const { createPullRequestReader, listOpenPullRequests, readPullRequests } = require("../pull-request.cjs");
const { createPullRequestWatch } = require("../pull-request-watch.cjs");
const { createPullRequestList } = require("../pull-request-list.cjs");
const { registerPrReviews } = require("../pr-reviews.cjs");

/** The recent Projects the sidebar shows, with their `origin` remotes: the repositories the Pull requests page lists. */
async function pullRequestProjects(commands) {
  const recent = await commands.get("project:recent")({});
  return recent.filter((entry) => !entry.hidden).map((entry) => ({ path: entry.path, name: entry.name, origin: entry.origin ?? null }));
}

const chatTitleOf = (session) => session.title || session.generatedTitle || session.summary?.titleLine || "Chat";

function registerPullRequests({ commands, options, states, emit, environmentReady }, services) {
  const injectedPullRequests = Boolean(options.readPullRequest || options.readPullRequests);
  const readPullRequest = options.readPullRequest ?? createPullRequestReader();
  const pullRequestWatch = injectedPullRequests
    ? null
    : createPullRequestWatch({
        exec: options.pullRequestExec,
        onChange: (folders) => {
          for (const projectPath of new Set(folders.map((folder) => states.worktreeProject(folder)).filter(Boolean)))
            emit("pull-requests:changed", { projectPath });
        },
      });
  commands.handle("worktree:pull-request", async (_event, worktreePath) => {
    await environmentReady;
    return pullRequestWatch ? pullRequestWatch.branch(worktreePath) : readPullRequest(worktreePath);
  });
  commands.handle("worktree:pull-requests", async (_event, worktreePath, refs) => {
    await environmentReady;
    return pullRequestWatch ? pullRequestWatch.refs(worktreePath, refs) : (options.readPullRequests ?? readPullRequests)(worktreePath, refs);
  });
  async function pullRequestTargets(projectPath) {
    const state = await states.get(projectPath);
    const byPath = new Map();
    for (const session of Object.values(state.sessions ?? {})) {
      const worktree = !session.archived ? state.worktrees?.[session.worktree_id] : undefined;
      if (!worktree) continue;
      const refs = byPath.get(worktree.path) ?? new Set();
      for (const ref of session.summary?.pullRequests ?? []) if (typeof ref === "string") refs.add(ref);
      if (!session.summary || session.summary.count > 0 || refs.size) byPath.set(worktree.path, refs);
    }
    return [...byPath].map(([folder, refs]) => ({ path: folder, refs: [...refs] }));
  }
  commands.handle("pull-requests:snapshot", async (_event, projectPath) => {
    if (typeof projectPath !== "string" || !states.has(projectPath)) return { worktrees: {}, chats: {}, pending: false };
    await environmentReady;
    const targets = await pullRequestTargets(projectPath);
    if (pullRequestWatch) return pullRequestWatch.snapshot(targets);
    const worktrees = {};
    const chats = {};
    await Promise.all(
      targets.map(async ({ path: folder, refs }) => {
        worktrees[folder] = await readPullRequest(folder).catch(() => null);
        if (refs.length) {
          const found = await (options.readPullRequests ?? readPullRequests)(folder, refs).catch(() => []);
          chats[folder] = Object.fromEntries(refs.map((ref, index) => [ref, found[index] ?? null]));
        }
      }),
    );
    return { worktrees, chats, pending: false };
  });
  const openPullRequests = new Map();
  const OPEN_PULL_REQUESTS_MS = 60_000;
  commands.handle("pull-requests:open", async (_event, projectPath) => {
    if (typeof projectPath !== "string" || !states.has(projectPath)) return [];
    await environmentReady;
    const hit = openPullRequests.get(projectPath);
    if (hit && Date.now() - hit.at < OPEN_PULL_REQUESTS_MS) return hit.read;
    const read = (options.listOpenPullRequests ?? listOpenPullRequests)(projectPath).catch(() => {
      if (openPullRequests.get(projectPath)?.read === read) openPullRequests.delete(projectPath);
      return [];
    });
    openPullRequests.set(projectPath, { at: Date.now(), read });
    return read;
  });
  const pullRequestList = options.pullRequestList ?? createPullRequestList({ exec: options.pullRequestListExec });
  function chatsByUrl() {
    const byUrl = new Map();
    for (const projectPath of states.projects()) {
      const state = states.loaded(projectPath);
      for (const session of Object.values(state?.sessions ?? {})) {
        if (session.archived) continue;
        for (const ref of session.summary?.pullRequests ?? []) {
          if (typeof ref !== "string" || !ref.includes("/pull/")) continue;
          const chats = byUrl.get(ref) ?? [];
          chats.push({ projectPath, chatId: session.id, title: chatTitleOf(session) });
          byUrl.set(ref, chats);
        }
      }
    }
    return byUrl;
  }
  commands.handle("pull-requests:list", async (_event, request = {}) => {
    await environmentReady;
    const byUrl = chatsByUrl();
    return pullRequestList.list({
      projects: await pullRequestProjects(commands),
      state: typeof request?.state === "string" ? request.state : "open",
      force: request?.force === true,
      chatsFor: (url) => byUrl.get(url) ?? [],
    });
  });
  commands.handle("pull-requests:checks", async (_event, request = {}) => {
    await environmentReady;
    return pullRequestList.checksOf({ repo: request?.repo, number: request?.number });
  });
  const reviews = registerPrReviews({
    commands,
    dataDir: options.dataDir,
    emit,
    sendFix: async (review, body, clientMessageId) => {
      const { projectOfKey, sessionIdFromKey, lastUserModel } = require("@milagre/shared/agent-runs");
      const author = chatsByUrl()
        .get(review.url)
        ?.find((chat) => `${chat.projectPath}#${chat.chatId}` !== review.chatId);
      const projectPath = author?.projectPath ?? (review.chatId && projectOfKey(review.chatId));
      const sessionId = author?.chatId ?? (review.chatId && sessionIdFromKey(review.chatId));
      if (!projectPath || !sessionId) throw new Error("No Chat is available for this pull request.");
      const state = await states.load(projectPath, [sessionId]);
      const session = state.sessions[sessionId];
      if (!session || session.archived || session.formerWorktree || session.readOnlyReason) throw new Error("This Chat is unavailable.");
      const saved = services().chats.turnSettings(`${projectPath}#${sessionId}`) ?? {};
      await commands.get("chat:send")(
        {},
        {
          projectPath,
          sessionId,
          worktreeId: session.worktree_id,
          provider: session.provider ?? saved.provider,
          model: lastUserModel(state, sessionId) || saved.model,
          permissionMode: session.permissionMode ?? saved.permissionMode ?? "ask",
          effort: saved.effort,
          delivery: "queue",
          body,
          prompt: body,
          files: [],
          images: [],
          clientMessageId,
        },
      );
    },
    babysit: () => async (url, findings) => Boolean(services().routines?.reviewFindings?.(url, findings)),
  });
  commands.handle("pr-reviews:report", (_event, report, chatId) => reviews.report(report, typeof chatId === "string" ? chatId : null));
  return {
    watching: Boolean(pullRequestWatch),
    poke: (folder) => pullRequestWatch?.poke(folder),
    close: () => pullRequestWatch?.close(),
  };
}

module.exports = { registerPullRequests };

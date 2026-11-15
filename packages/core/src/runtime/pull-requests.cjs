const { createPullRequestReader, listOpenPullRequests, readPullRequests } = require("../pull-request.cjs");
const { createPullRequestWatch } = require("../pull-request-watch.cjs");

function registerPullRequests({ commands, options, states, emit, environmentReady }) {
  // Branch and Chat PRs are polled here for every client (pull-request-watch.cjs, spec 2026-10-30-daemon-pr-polling):
  // a read answers from the last poll, and `pull-requests:changed` tells clients when a Project's PRs changed. A
  // harness that injects its own readers gets them called directly instead.
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
  // A Project's Worktrees with Chats, and the PRs those Chats named, as the sidebar and the phone's list show them.
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
  /** Every PR the Project's Worktrees and Chats have, from the last poll: it never waits on GitHub. */
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
  // The repository's open PRs for a new Chat's card, read once a minute at most per Project; a failed read answers [].
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
  return {
    watching: Boolean(pullRequestWatch),
    poke: (folder) => pullRequestWatch?.poke(folder),
    close: () => pullRequestWatch?.close(),
  };
}

module.exports = { registerPullRequests };

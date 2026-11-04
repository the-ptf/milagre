// Settings › Devices › What Milagre uses › Clean up worktrees: the worktrees Milagre made that nothing has used for a
// while, on desktop and phone. A worktree's Chats go with it when it is removed (worktree:remove), so one is offered only
// while none of its Chats runs, and its age is its newest Chat's last message, or the folder's when no Chat has one.
const fs = require("node:fs/promises");
const path = require("node:path");

const DAY = 24 * 60 * 60_000;
/** The shortest idle time the cleanup offers; the dialog narrows it to 30, 60 or 90 days. */
const MIN_IDLE_DAYS = 30;
// Each worktree's git status is a few git calls; this many run at once.
const STATUS_AT_ONCE = 4;

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * One Project's worktrees that could go: Milagre made them (a base, under a worktree root), the Project folder isn't
 * one, no shared Link Chat owns them and none of their Chats runs. `lastAt` is the newest Chat message, or null when no
 * Chat on it has one (the caller reads the folder's time). `title` is its newest Chat's name, else its branch.
 */
function worktreeCandidates({ projectPath, projectName, state, roots, linkOwned = new Set(), busy = () => false, titleOf = () => "" }) {
  const sessions = Object.values(state?.sessions ?? {});
  const list = [];
  for (const worktree of Object.values(state?.worktrees ?? {})) {
    if (!worktree?.base || typeof worktree.path !== "string" || worktree.path === projectPath) continue;
    if (!roots.some((root) => inside(root, worktree.path)) || linkOwned.has(worktree.path)) continue;
    const own = sessions.filter((session) => session.worktree_id === worktree.id);
    if (own.some((session) => busy(`${projectPath}#${session.id}`))) continue;
    let lastAt = null;
    let newest = null;
    for (const session of own) {
      const at = session.summary?.lastAt;
      if (typeof at === "number" && Number.isFinite(at) && (lastAt === null || at > lastAt)) {
        lastAt = at;
        newest = session;
      }
    }
    newest ??= own.toSorted((a, b) => b.id - a.id)[0] ?? null;
    list.push({
      projectPath,
      projectName,
      path: worktree.path,
      base: worktree.base,
      branch: worktree.name ?? null,
      title: (newest && titleOf(newest)) || worktree.name || path.basename(worktree.path),
      chats: own.length,
      lastAt,
    });
  }
  return list;
}

/** Runs `work` over `items`, `limit` at a time, in order. */
async function eachLimited(items, limit, work) {
  const results = Array.from({ length: items.length });
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Every idle worktree on this computer, oldest first, each with its git status (what removing it loses) and its size at
 * the last disk measure (null before one). A worktree whose status git can't read is left out: it can't be removed
 * safely, nor forced against a status nobody saw.
 */
async function idleWorktrees({
  projects,
  readState,
  roots,
  linkOwned,
  busy,
  titleOf,
  openAsProject = async () => false,
  status,
  bytesOf = () => null,
  now = Date.now(),
  minIdleDays = MIN_IDLE_DAYS,
  stat = fs.stat,
}) {
  const found = [];
  for (const project of projects) {
    const state = await Promise.resolve(readState(project.path)).catch(() => null);
    if (state) found.push(...worktreeCandidates({ projectPath: project.path, projectName: project.name, state, roots, linkOwned, busy, titleOf }));
  }
  const cutoff = now - minIdleDays * DAY;
  const idle = [];
  for (const candidate of found) {
    const lastAt =
      candidate.lastAt ??
      (await stat(candidate.path).then(
        (info) => info.mtimeMs,
        () => null,
      ));
    // A folder git still lists but that is gone frees nothing here.
    if (lastAt === null || lastAt > cutoff) continue;
    if (await openAsProject(candidate.path)) continue;
    idle.push({ ...candidate, lastAt });
  }
  const checked = await eachLimited(idle, STATUS_AT_ONCE, async (candidate) => {
    const seen = await status(candidate.path, candidate.base).catch(() => null);
    if (!seen) return null;
    const { base: _base, ...rest } = candidate;
    return { ...rest, bytes: bytesOf(candidate.path), status: seen };
  });
  return checked.filter(Boolean).toSorted((a, b) => a.lastAt - b.lastAt);
}

module.exports = { DAY, MIN_IDLE_DAYS, worktreeCandidates, idleWorktrees, eachLimited };

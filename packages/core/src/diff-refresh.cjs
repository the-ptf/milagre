const { isTurnEnd, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { withDiffStats } = require("@milagre/shared/project-edits");

const EDIT_DEBOUNCE = 1200;
const FOCUS_THROTTLE = 5000;
const FILE_STEP_KINDS = new Set(["edit", "shell", "other"]);

class DiffRefresher {
  constructor({ states, readDiffStat, update, debounceMs = EDIT_DEBOUNCE, throttleMs = FOCUS_THROTTLE, now = Date.now }) {
    Object.assign(this, { states, readDiffStat, update, debounceMs, throttleMs, now });
    this.timers = new Map();
    this.lastFocus = new Map();
    this.stepKinds = new Map();
    this.pending = [];
    this.active = 0;
  }

  observe(chatId, event) {
    if (this.closed) return;
    if (event.type === "step-started" && event.step) {
      if (!this.stepKinds.has(chatId)) this.stepKinds.set(chatId, new Map());
      this.stepKinds.get(chatId).set(event.step.id, event.step.kind);
    }
    if (event.type === "step-completed") {
      const kinds = this.stepKinds.get(chatId);
      const kind = kinds?.get(event.id);
      kinds?.delete(event.id);
      if (kind !== undefined && !FILE_STEP_KINDS.has(kind)) return;
    }
    if (isTurnEnd(event)) this.stepKinds.delete(chatId);
    if (event.type !== "step-completed" && !isTurnEnd(event)) return;
    clearTimeout(this.timers.get(chatId));
    const timer = setTimeout(() => {
      this.timers.delete(chatId);
      void this.refreshChat(chatId).catch(() => {});
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(chatId, timer);
  }

  close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.stepKinds.clear();
    for (const job of this.pending.splice(0)) job.resolve(null);
  }

  focused(projectPath) {
    if (this.closed || !projectPath || !this.states.has(projectPath)) return;
    if (this.now() - (this.lastFocus.get(projectPath) ?? -Infinity) < this.throttleMs) return;
    this.lastFocus.set(projectPath, this.now());
    void this.refresh(projectPath).catch(() => {});
  }

  focusedChat(chatId) {
    const projectPath = typeof chatId === "string" ? projectOfKey(chatId) : null;
    if (this.closed || !projectPath || !this.states.has(projectPath)) return;
    void this.refreshOpened(projectPath, sessionIdFromKey(chatId)).catch(() => {});
  }

  async refreshOpened(projectPath, sessionId) {
    const worktreeId = (await this.states.get(projectPath)).sessions[sessionId]?.worktree_id;
    if (worktreeId === undefined || this.closed) return;
    const key = `${projectPath}\0${worktreeId}`;
    const now = this.now();
    const recent = (read) => now - (this.lastFocus.get(read) ?? -Infinity) < this.throttleMs;
    if (recent(key)) return;
    this.lastFocus.set(key, now);
    await this.refresh(projectPath, [worktreeId]);
  }

  read(worktree) {
    if (this.closed || !worktree) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pending.push({ worktree, resolve });
      this.drain();
    });
  }

  drain() {
    while (!this.closed && this.active < 4 && this.pending.length) {
      const { worktree, resolve } = this.pending.shift();
      this.active++;
      Promise.resolve()
        .then(() => this.readDiffStat(worktree.path, worktree.base))
        .catch(() => null)
        .then(resolve)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }

  async refreshChat(chatId) {
    const projectPath = projectOfKey(chatId);
    if (!this.states.has(projectPath)) return;
    const worktreeId = (await this.states.get(projectPath)).sessions[sessionIdFromKey(chatId)]?.worktree_id;
    if (worktreeId !== undefined) await this.refresh(projectPath, [worktreeId]);
  }

  async refresh(projectPath, worktreeIds) {
    if (this.closed) return;
    const state = await this.states.get(projectPath);
    const ids = worktreeIds ?? worktreesWithChats(state);
    if (!worktreeIds) for (const id of ids) this.lastFocus.set(`${projectPath}\0${id}`, this.now());
    const stats = await Promise.all(
      ids.map(async (id) => {
        const worktree = state.worktrees[id];
        return [id, await this.read(worktree)];
      }),
    );
    if (this.closed) return;
    await this.update(projectPath, (latest) => withDiffStats(latest, Object.fromEntries(stats)), { chats: [] });
  }
}

function worktreesWithChats(state) {
  const sessions = Object.values(state.sessions ?? {}).filter((session) => !session.archived && session.routine?.hidden !== true);
  if (sessions.every((session) => session.summary))
    return [
      ...new Set(
        sessions
          .filter((session) => session.summary.count > 0)
          .map((session) => session.worktree_id)
          .filter((id) => id !== undefined),
      ),
    ];
  const open = new Set(sessions.map((session) => String(session.id)));
  return [
    ...new Set(
      state.messages
        .filter((message) => open.has(String(message.session_id)))
        .map((message) => state.sessions[message.session_id]?.worktree_id)
        .filter((id) => id !== undefined),
    ),
  ];
}
module.exports = { DiffRefresher };

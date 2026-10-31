const messageStore = require("./message-store.cjs");

// A Chat nobody touched for this long, whose turn isn't running, leaves memory (see `messages` below).
const IDLE_MS = 10 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

// The single writer of each Project's in-memory state. Disk I/O has its own bounded,
// coalescing write-behind path, so a slow save cannot stall another Chat's events.
class ProjectStates {
  /**
   * `compact(key, next, previous)` (optional) slims a state before it is kept, e.g. moving tool output to sidecars.
   *
   * `messages` (optional) keeps only some Chats' messages in memory (#321; see message-store.cjs). It names the
   * folder whose chats.db holds a key's messages (`directory(key)`) and whether a Chat is busy (`active(key, chatId)`:
   * a turn running or preparing). A Chat not touched for `idleMs`, not busy and saved as it is, is unloaded by a sweep
   * every `sweepMs`; a change or read that names it loads it back. `unloaded(key, state)` (optional) hears of each state
   * a sweep made. Without `messages` every message stays in memory.
   */
  constructor({ read, save, compact, debounceMs = 250, messages = null, persistenceChanged }) {
    Object.assign(this, { read, save, compact, debounceMs, persistenceChanged });
    this.failures = new Map();
    this.messages = messages && { idleMs: IDLE_MS, sweepMs: SWEEP_MS, active: () => false, now: Date.now, ...messages };
    this.states = new Map();
    this.queues = new Map();
    this.dirty = new Map();
    this.writes = new Map();
    this.timers = new Map();
    this.due = new Map();
    this.transient = new Set();
    // Per key, Chat id -> when it was last touched (named by a change or read, or its messages changed); and when the
    // key was read, for Chats not touched since.
    this.touches = new Map();
    this.readAt = new Map();
  }
  has(projectPath) {
    return this.states.has(projectPath);
  }
  projects() {
    return [...this.states.keys()];
  }
  /** Reconciled Worktree folders; never starts a Git process. */
  worktreePaths() {
    return [...this.states.values()].flatMap((state) => Object.values(state.worktrees ?? {}).map((worktree) => worktree.path));
  }
  /** The loaded Project a reconciled Worktree folder belongs to, or null; never starts a Git process. */
  worktreeProject(folder) {
    for (const [projectPath, state] of this.states) if (Object.values(state.worktrees ?? {}).some((worktree) => worktree.path === folder)) return projectPath;
    return null;
  }
  /** The Worktree folder of a loaded Project's Chat, or null. */
  chatWorktreePath(projectPath, sessionId) {
    const state = this.states.get(projectPath);
    const worktreeId = state?.sessions?.[sessionId]?.worktree_id;
    return (worktreeId !== undefined && state.worktrees?.[worktreeId]?.path) || null;
  }
  /** The latest state. It may leave out unloaded Chats' messages (see `messages`); read those with the methods below. */
  async get(projectPath) {
    return (await this.update(projectPath, (state) => state, { chats: [] })).state;
  }
  /** The latest state with the Chats `chats` (ids) loaded. */
  async load(projectPath, chats) {
    return (await this.update(projectPath, (state) => state, { chats })).state;
  }
  /** Runs `reader(state, directory)` on the latest state, in turn with changes, without loading anything. */
  async readWith(projectPath, reader) {
    let result;
    await this.update(
      projectPath,
      (state) => {
        result = reader(state, this.messages ? this.messages.directory(projectPath) : null);
        return state;
      },
      { chats: [] },
    );
    return result;
  }
  /** Every message, in the Project's order: unloaded Chats' read from chats.db for this call only. */
  // `withState`: { state, messages }, both from the one state read, for a reader that puts them together.
  allMessages(projectPath, { withState = false } = {}) {
    return this.readWith(projectPath, (state, directory) => {
      const messages = directory ? messageStore.allMessages(directory, state) : state.messages;
      return withState ? { state, messages } : messages;
    });
  }
  /** The messages of the Chats `chats` (ids), in the Project's order, without loading them. */
  chatMessages(projectPath, chats) {
    return this.readWith(projectPath, (state, directory) => {
      if (directory) return messageStore.chatMessages(directory, state, chats);
      const wanted = new Set([...chats].map(Number));
      return state.messages.filter((message) => wanted.has(Number(message.session_id)));
    });
  }
  /** Metadata and bounded inbox previews; leaves idle transcripts unloaded. */
  inboxState(projectPath) {
    return this.readWith(projectPath, (state, directory) => messageStore.inboxState(directory, state));
  }
  /** { id, session_id, role, outcome, clientMessageId } of every message, in the Project's order, without loading any. */
  messageMarks(projectPath, { withState = false } = {}) {
    return this.readWith(projectPath, (state, directory) => {
      const messages = directory
        ? messageStore.messageMarks(directory, state)
        : state.messages.map(({ id, session_id, role, outcome, clientMessageId }) => ({ id, session_id, role, outcome, clientMessageId }));
      return withState ? { state, messages } : messages;
    });
  }
  /** The messages in memory and the unloaded ones whose saved JSON contains one of `needles`, without loading them. */
  messagesContaining(projectPath, needles) {
    return this.readWith(projectPath, (state, directory) => (directory ? messageStore.messagesContaining(directory, state, needles) : state.messages));
  }
  /** { id, session_id, body } of the messages of the Chats `chats` (every Chat when not given), for a search. */
  searchableMessages(projectPath, chats) {
    return this.readWith(projectPath, (state, directory) => {
      if (directory) return messageStore.searchableMessages(directory, state, chats);
      const wanted = chats ? new Set([...chats].map(Number)) : null;
      return state.messages.filter((message) => !wanted || wanted.has(Number(message.session_id)));
    });
  }
  /** The first message whose `field` (id, operationId or clientMessageId) is `value`, from chats.db for an unloaded Chat. */
  findMessage(projectPath, field, value) {
    return this.readWith(projectPath, (state, directory) =>
      directory ? messageStore.findMessage(directory, state, field, value) : state.messages.find((message) => message[field] === value),
    );
  }

  /**
   * Serializes mutations, including async changes, but never waits for a save. `chats` (with `messages`) lists the
   * Chats whose messages the change reads or writes: they are loaded first. Without it every unloaded Chat is, since
   * the change could read any of them; pass [] for a change that reads no messages.
   */
  update(projectPath, change, { persist = true, chats } = {}) {
    if (this.closed) return Promise.reject(new Error("Project state is closed"));
    return this.enqueue(projectPath, async () => {
      let state = this.states.get(projectPath);
      if (state === undefined) {
        state = await this.slim(projectPath, await this.read(projectPath), null);
        this.states.set(projectPath, state);
        if (this.messages) {
          this.readAt.set(projectPath, this.messages.now());
          this.startSweep();
        }
      }
      if (this.messages) {
        // Loading is not a change: what is on disk stays as it is, and nothing is sent.
        const loaded = this.prepare(projectPath, state, chats);
        if (loaded !== state) this.states.set(projectPath, (state = loaded));
      }
      const changed = await change(state);
      if (changed === state) return { state: this.states.get(projectPath), changed: false };
      let next = changed;
      let unloaded;
      if (this.messages) {
        const settled = messageStore.settle(this.messages.directory(projectPath), state, next);
        next = settled.state;
        unloaded = messageStore.unloadedChats(next);
        this.touch(projectPath, settled.touched);
      }
      next = await this.slim(projectPath, next, state);
      // A compaction that copied the messages array keeps the Chats unloaded as they were.
      if (unloaded && Array.isArray(next?.messages)) messageStore.tag(next.messages, this.messages.directory(projectPath), unloaded);
      next = this.withPersistence(projectPath, next);
      this.states.set(projectPath, next);
      if (persist) {
        this.transient.delete(projectPath);
        this.dirty.set(projectPath, next);
        this.due.set(projectPath, Date.now() + this.debounceMs);
        this.schedule(projectPath);
      } else this.transient.add(projectPath);
      return { state: next, changed: true };
    });
  }
  /** Runs `work` after every change to the project asked for before it. */
  enqueue(projectPath, work) {
    const run = (this.queues.get(projectPath) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(projectPath, run);
    const forget = () => {
      if (this.queues.get(projectPath) === run) this.queues.delete(projectPath);
    };
    run.then(forget, forget);
    return run;
  }

  /** `state` with the Chats a change asked for loaded (every unloaded one when it named none). */
  prepare(projectPath, state, chats) {
    const unloaded = messageStore.unloadedChats(state);
    if (chats !== undefined) this.touch(projectPath, chats);
    if (!unloaded.size) return state;
    const wanted = chats === undefined ? [...unloaded] : [...chats].map(Number).filter((chat) => unloaded.has(chat));
    if (chats === undefined) this.touch(projectPath, wanted);
    return wanted.length ? messageStore.loadChats(this.messages.directory(projectPath), state, wanted) : state;
  }

  touch(projectPath, chats) {
    if (!this.messages) return;
    let touched = this.touches.get(projectPath);
    if (!touched) this.touches.set(projectPath, (touched = new Map()));
    const now = this.messages.now();
    for (const chat of chats) if (Number.isFinite(Number(chat))) touched.set(Number(chat), now);
  }

  /**
   * Unloads, in each project, the Chats not touched for `idleMs` whose turn isn't busy, once nothing is waiting to be
   * saved: chats.db then holds what memory does. A Chat with anything not saved stays (see unloadChats).
   */
  async unloadIdle() {
    if (!this.messages || this.closed) return;
    await Promise.all(
      this.projects().map((projectPath) =>
        this.enqueue(projectPath, () => {
          const directory = this.messages.directory(projectPath);
          messageStore.forgetRest(directory);
          if (this.closed || this.dirty.has(projectPath) || this.writes.has(projectPath)) return;
          const state = this.states.get(projectPath);
          if (!Array.isArray(state?.messages)) return;
          const now = this.messages.now();
          const since = this.readAt.get(projectPath) ?? now;
          const touched = this.touches.get(projectPath);
          const idle = new Set();
          const checked = new Set();
          for (const message of state.messages) {
            const chat = Number(message.session_id);
            if (checked.has(chat)) continue;
            checked.add(chat);
            if (now - (touched?.get(chat) ?? since) >= this.messages.idleMs && !this.messages.active(projectPath, chat)) idle.add(chat);
          }
          if (!idle.size) return;
          const next = messageStore.unloadChats(directory, state, idle);
          if (next === state) return;
          this.states.set(projectPath, next);
          // Whoever keeps the last state it sent (the daemon, for patches) lets go of the unloaded messages.
          this.messages.unloaded?.(projectPath, next);
        }),
      ),
    );
  }

  startSweep() {
    if (this.sweep || !this.messages?.sweepMs) return;
    this.sweep = setInterval(
      () => void this.unloadIdle().catch((error) => console.warn("Milagre couldn't unload idle chats:", error.message)),
      this.messages.sweepMs,
    );
    this.sweep.unref?.();
  }

  /** The state compacted; as it is when there is no compaction or it fails (the save tries again). */
  async slim(projectPath, next, previous) {
    if (!this.compact || !next) return next;
    try {
      return await this.compact(projectPath, next, previous);
    } catch (error) {
      console.warn(`Milagre couldn't move tool output out of ${projectPath}'s state:`, error.message);
      return next;
    }
  }

  // Save status is runtime metadata. Keep it authoritative across async mutations, but never write it to disk.
  withPersistence(projectPath, state) {
    const persistence = this.failures.get(projectPath);
    if (state.persistence === persistence) return state;
    const { persistence: _previous, ...content } = state;
    return persistence ? { ...content, persistence } : content;
  }

  setPersistence(projectPath, persistence) {
    if (persistence) this.failures.set(projectPath, persistence);
    else this.failures.delete(projectPath);
    const state = this.withPersistence(projectPath, this.states.get(projectPath));
    this.states.set(projectPath, state);
    try {
      this.persistenceChanged?.(projectPath, state);
    } catch (error) {
      console.warn("Milagre couldn't announce save status:", error.message);
    }
  }

  schedule(projectPath) {
    clearTimeout(this.timers.get(projectPath));
    const timer = setTimeout(
      () => {
        this.timers.delete(projectPath);
        void this.write(projectPath).catch((error) => console.warn(`Milagre couldn't save ${projectPath}:`, error.message));
      },
      Math.max(0, (this.due.get(projectPath) ?? 0) - Date.now()),
    );
    timer.unref?.();
    this.timers.set(projectPath, timer);
  }

  /** At most one save per Project in flight; newer edits remain dirty. */
  write(projectPath) {
    if (this.writes.has(projectPath)) return this.writes.get(projectPath);
    if (!this.dirty.has(projectPath)) return Promise.resolve();
    const { persistence: _runtime, ...state } = this.dirty.get(projectPath);
    this.dirty.delete(projectPath);
    const failure = this.failures.get(projectPath);
    let failed = false;
    const writing = Promise.resolve()
      .then(() => {
        if (failure) this.setPersistence(projectPath, { ...failure, saving: true });
        return this.save(projectPath, state);
      })
      .catch((error) => {
        failed = true;
        if (!this.dirty.has(projectPath)) this.dirty.set(projectPath, state);
        this.setPersistence(projectPath, { error: error.message || String(error), ...(error.code ? { code: String(error.code) } : {}), saving: false });
        throw error;
      })
      .finally(async () => {
        this.writes.delete(projectPath);
        // A mutation already requested may still be awaiting compaction. Settle status after it commits, so a newer
        // transient update cannot lose the warning even though it schedules no ordinary save.
        if (!failed && this.failures.has(projectPath))
          await this.enqueue(projectPath, () => {
            if (!this.failures.has(projectPath)) return;
            const unsaved = this.dirty.has(projectPath) || this.transient.has(projectPath) || this.writes.has(projectPath);
            this.setPersistence(projectPath, unsaved ? { ...this.failures.get(projectPath), saving: this.writes.has(projectPath) } : undefined);
          });
        // A timer may have fired during the save. Do not lose that newer edit.
        if (!failed && this.dirty.has(projectPath) && !this.timers.has(projectPath)) this.schedule(projectPath);
      });
    this.writes.set(projectPath, writing);
    return writing;
  }

  /** Saves a Project, then drops it from memory as if it was never read: for a folder about to move (a deleted bot's home). */
  async forget(projectPath) {
    await this.flush(projectPath);
    await this.enqueue(projectPath, () => {
      clearTimeout(this.timers.get(projectPath));
      for (const map of [this.states, this.dirty, this.timers, this.due, this.touches, this.readAt, this.failures]) map.delete(projectPath);
      this.transient.delete(projectPath);
      if (this.messages) messageStore.resetStore(this.messages.directory(projectPath));
    });
  }

  /** An explicit retry includes the latest transient updates too, without changing ordinary flush semantics. */
  async retry(projectPath) {
    await this.enqueue(projectPath, () => {
      if (!this.states.has(projectPath)) throw new Error("Open the Project before retrying its save.");
      if (!this.failures.has(projectPath)) return;
      this.dirty.set(projectPath, this.states.get(projectPath));
      this.transient.delete(projectPath);
    });
    await this.flush(projectPath);
  }

  async close() {
    this.closed = true;
    clearInterval(this.sweep);
    await Promise.all([...this.queues.values()].map((work) => work.catch(() => {})));
    for (const projectPath of this.transient) this.dirty.set(projectPath, this.states.get(projectPath));
    this.transient.clear();
    return this.flush();
  }

  /** Durability boundary for quit and accepted user messages. Failed writes stay dirty and reject. */
  async flush(projectPath) {
    const entries = (map) => (projectPath === undefined ? [...map.entries()] : map.has(projectPath) ? [[projectPath, map.get(projectPath)]] : []);
    await Promise.all(entries(this.queues).map(([, work]) => work.catch(() => {})));
    await Promise.all(entries(this.writes).map(([, work]) => work.catch(() => {})));
    while (entries(this.dirty).length) {
      const pending = entries(this.dirty).map(([key]) => {
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
        return this.write(key);
      });
      await Promise.all(pending);
    }
  }
}
module.exports = { ProjectStates };

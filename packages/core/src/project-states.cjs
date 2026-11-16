const messageStore = require("./message-store.cjs");

const IDLE_MS = 10 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

class ProjectStates {
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
    this.touches = new Map();
    this.readAt = new Map();
  }
  has(projectPath) {
    return this.states.has(projectPath);
  }
  projects() {
    return [...this.states.keys()];
  }
  worktreePaths() {
    return [...this.states.values()].flatMap((state) => Object.values(state.worktrees ?? {}).map((worktree) => worktree.path));
  }
  worktreeProject(folder) {
    for (const [projectPath, state] of this.states) if (Object.values(state.worktrees ?? {}).some((worktree) => worktree.path === folder)) return projectPath;
    return null;
  }
  chatWorktreePath(projectPath, sessionId) {
    const state = this.states.get(projectPath);
    const worktreeId = state?.sessions?.[sessionId]?.worktree_id;
    return (worktreeId !== undefined && state.worktrees?.[worktreeId]?.path) || null;
  }
  async get(projectPath) {
    return (await this.update(projectPath, (state) => state, { chats: [] })).state;
  }
  async load(projectPath, chats) {
    return (await this.update(projectPath, (state) => state, { chats })).state;
  }
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
  allMessages(projectPath, { withState = false } = {}) {
    return this.readWith(projectPath, (state, directory) => {
      const messages = directory ? messageStore.allMessages(directory, state) : state.messages;
      return withState ? { state, messages } : messages;
    });
  }
  chatMessages(projectPath, chats) {
    return this.readWith(projectPath, (state, directory) => {
      if (directory) return messageStore.chatMessages(directory, state, chats);
      const wanted = new Set([...chats].map(Number));
      return state.messages.filter((message) => wanted.has(Number(message.session_id)));
    });
  }
  inboxState(projectPath) {
    return this.readWith(projectPath, (state, directory) => messageStore.inboxState(directory, state));
  }
  messageMarks(projectPath, { withState = false } = {}) {
    return this.readWith(projectPath, (state, directory) => {
      const messages = directory
        ? messageStore.messageMarks(directory, state)
        : state.messages.map(({ id, session_id, role, outcome, clientMessageId }) => ({ id, session_id, role, outcome, clientMessageId }));
      return withState ? { state, messages } : messages;
    });
  }
  messagesContaining(projectPath, needles) {
    return this.readWith(projectPath, (state, directory) => (directory ? messageStore.messagesContaining(directory, state, needles) : state.messages));
  }
  searchableMessages(projectPath, chats) {
    return this.readWith(projectPath, (state, directory) => {
      if (directory) return messageStore.searchableMessages(directory, state, chats);
      const wanted = chats ? new Set([...chats].map(Number)) : null;
      return state.messages.filter((message) => !wanted || wanted.has(Number(message.session_id)));
    });
  }
  findMessage(projectPath, field, value) {
    return this.readWith(projectPath, (state, directory) =>
      directory ? messageStore.findMessage(directory, state, field, value) : state.messages.find((message) => message[field] === value),
    );
  }

  update(projectPath, change, { persist = true, chats } = {}) {
    if (this.closed) return Promise.reject(new Error("Project state is closed"));
    return this.enqueue(projectPath, async () => {
      let state = this.states.get(projectPath);
      if (state === undefined) {
        state = await this.slim(projectPath, await this.read(projectPath), null);
        if (this.messages && chats !== undefined) state = this.shedOld(projectPath, state);
        this.states.set(projectPath, state);
        if (this.messages) {
          this.readAt.set(projectPath, this.messages.now());
          this.startSweep();
        }
      }
      if (this.messages) {
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
  enqueue(projectPath, work) {
    const run = (this.queues.get(projectPath) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(projectPath, run);
    const forget = () => {
      if (this.queues.get(projectPath) === run) this.queues.delete(projectPath);
    };
    run.then(forget, forget);
    return run;
  }

  prepare(projectPath, state, chats) {
    const unloaded = messageStore.unloadedChats(state);
    if (chats !== undefined) this.touch(projectPath, chats);
    if (!unloaded.size) return state;
    const wanted = chats === undefined ? [...unloaded] : [...chats].map(Number).filter((chat) => unloaded.has(chat));
    if (chats === undefined) this.touch(projectPath, wanted);
    return wanted.length ? messageStore.loadChats(this.messages.directory(projectPath), state, wanted) : state;
  }

  shedOld(projectPath, state) {
    const now = this.messages.now();
    const old = new Set();
    for (const [id, session] of Object.entries(state?.sessions ?? {})) {
      const lastAt = Number(session?.summary?.lastAt);
      if (Number.isFinite(lastAt) && now - lastAt >= this.messages.idleMs && !this.messages.active(projectPath, Number(id))) old.add(Number(id));
    }
    if (!old.size || !Array.isArray(state.messages)) return state;
    return messageStore.unloadChats(this.messages.directory(projectPath), state, old);
  }

  touch(projectPath, chats) {
    if (!this.messages) return;
    let touched = this.touches.get(projectPath);
    if (!touched) this.touches.set(projectPath, (touched = new Map()));
    const now = this.messages.now();
    for (const chat of chats) if (Number.isFinite(Number(chat))) touched.set(Number(chat), now);
  }

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

  async slim(projectPath, next, previous) {
    if (!this.compact || !next) return next;
    try {
      return await this.compact(projectPath, next, previous);
    } catch (error) {
      console.warn(`Milagre couldn't move tool output out of ${projectPath}'s state:`, error.message);
      return next;
    }
  }

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
        if (!failed && this.failures.has(projectPath))
          await this.enqueue(projectPath, () => {
            if (!this.failures.has(projectPath)) return;
            const unsaved = this.dirty.has(projectPath) || this.transient.has(projectPath) || this.writes.has(projectPath);
            this.setPersistence(projectPath, unsaved ? { ...this.failures.get(projectPath), saving: this.writes.has(projectPath) } : undefined);
          });
        if (!failed && this.dirty.has(projectPath) && !this.timers.has(projectPath)) this.schedule(projectPath);
      });
    this.writes.set(projectPath, writing);
    return writing;
  }

  async forget(projectPath) {
    await this.flush(projectPath);
    await this.enqueue(projectPath, () => {
      clearTimeout(this.timers.get(projectPath));
      for (const map of [this.states, this.dirty, this.timers, this.due, this.touches, this.readAt, this.failures]) map.delete(projectPath);
      this.transient.delete(projectPath);
      if (this.messages) messageStore.resetStore(this.messages.directory(projectPath));
    });
  }

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

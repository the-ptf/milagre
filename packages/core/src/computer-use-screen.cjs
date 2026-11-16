const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const INTERVAL_MS = 500;
const IDLE_MS = 20_000;
const WAIT_MS = 15_000;
const CAPTURE_SESSION = "milagre-capture";

const fileName = (chatId) => `${crypto.createHash("sha256").update(chatId).digest("hex").slice(0, 24)}.json`;

function createScreenFeed({ exec, dir, interval = INTERVAL_MS, idle = IDLE_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const feeds = new Map();
  const feed = (chatId) => {
    let state = feeds.get(chatId);
    if (!state) feeds.set(chatId, (state = { target: null, frame: stored(chatId), lastActive: 0, timer: null, capturing: false, waiters: new Set() }));
    return state;
  };

  function stored(chatId) {
    try {
      const frame = JSON.parse(fs.readFileSync(path.join(dir, fileName(chatId)), "utf8"));
      return typeof frame?.image === "string" ? { ...frame, seq: Number(frame.seq) || 1 } : null;
    } catch {
      return null;
    }
  }

  function persist(chatId, frame) {
    if (!frame?.image) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, fileName(chatId));
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(frame), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch {}
  }

  const view = (state, live) => {
    const frame = state.frame;
    return frame ? { ...frame, live } : { seq: 0, live };
  };

  function publish(state, frame) {
    state.frame = frame;
    for (const waiter of state.waiters) waiter();
  }

  async function capture(chatId, state) {
    const target = state.target;
    if (!target) return;
    const args = ["screenshot", ...(target.windowId ? ["--window-id", target.windowId] : ["--app", target.app]), "--session", CAPTURE_SESSION];
    const envelope = await exec(args, { timeoutMs: 10_000 });
    if (feeds.get(chatId) !== state) return;
    const previous = state.frame;
    if (!envelope.ok) {
      const code = envelope.error?.code;
      if (code === "WINDOW_NOT_FOUND" && target.windowId) target.windowId = null;
      const error = code === "PERM_DENIED" ? "screen-recording" : null;
      if (error && previous?.error !== error) publish(state, { seq: (previous?.seq ?? 0) + 1, app: target.app, title: target.title, at: now(), error });
      return;
    }
    const image = envelope.data?.data;
    if (typeof image !== "string") return;
    const hash = crypto.createHash("sha1").update(image).digest("hex");
    if (previous?.hash === hash && previous.app === target.app) return;
    publish(state, {
      seq: (previous?.seq ?? 0) + 1,
      app: target.app,
      title: target.title ?? null,
      at: now(),
      mime: `image/${envelope.data?.format ?? "png"}`,
      image,
      width: envelope.data?.width ?? null,
      height: envelope.data?.height ?? null,
      hash,
    });
  }

  function schedule(chatId) {
    const state = feed(chatId);
    if (state.timer || state.capturing) return;
    state.timer = setTimer(async () => {
      if (feeds.get(chatId) !== state) return;
      state.timer = null;
      state.capturing = true;
      try {
        await capture(chatId, state);
      } finally {
        state.capturing = false;
      }
      if (feeds.get(chatId) !== state) return;
      if (now() - state.lastActive < idle) schedule(chatId);
      else {
        persist(chatId, state.frame);
        for (const waiter of state.waiters) waiter();
      }
    }, interval);
  }

  function touch({ chatId, app, windowId, title }) {
    if (!chatId || !app) return;
    const state = feed(chatId);
    const same = state.target?.app === app;
    state.target = { app, windowId: windowId ?? (same ? state.target.windowId : null), title: title ?? (same ? state.target.title : null) };
    state.lastActive = now();
    schedule(chatId);
  }

  const live = (chatId) => {
    const state = feeds.get(chatId);
    return !!state && (state.timer !== null || state.capturing);
  };

  function next({ chatId, after = 0, timeoutMs = WAIT_MS }) {
    if (typeof chatId !== "string" || !chatId) throw new Error("Name the Chat.");
    const state = feed(chatId);
    if ((state.frame?.seq ?? 0) > after) return Promise.resolve(view(state, live(chatId)));
    return new Promise((resolve) => {
      const done = () => {
        clearTimer(timer);
        state.waiters.delete(done);
        resolve(view(state, live(chatId)));
      };
      const timer = setTimer(done, Math.min(Math.max(timeoutMs, 0), WAIT_MS));
      state.waiters.add(done);
    });
  }

  function forget(chatId) {
    const state = feeds.get(chatId);
    feeds.delete(chatId);
    if (state) {
      if (state.timer) clearTimer(state.timer);
      state.frame = null;
      state.target = null;
      for (const waiter of state.waiters) waiter();
    }
    fs.rmSync(path.join(dir, fileName(chatId)), { force: true });
  }

  return { touch, next, live, forget };
}

module.exports = { createScreenFeed, CAPTURE_SESSION };

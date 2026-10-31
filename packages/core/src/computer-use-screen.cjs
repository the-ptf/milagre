const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// The live screen of computer use: while a Chat's agent works in an app, the host captures the window it last read or
// acted on about twice a second, and viewers (the Chat's card on desktop and phone) long-poll for the next frame. The
// loop stops a while after the agent's last desktop tool, and the last frame is kept on disk so the card still shows
// it after the turn, or after a restart.

const INTERVAL_MS = 500;
const IDLE_MS = 20_000;
const WAIT_MS = 15_000;
// Its own ref namespace, so captures never wait on the agent's session.
const CAPTURE_SESSION = "milagre-capture";

const fileName = (chatId) => `${crypto.createHash("sha256").update(chatId).digest("hex").slice(0, 24)}.json`;

/**
 * `exec(args, options)` runs agent-desktop and answers its envelope. `dir` keeps each Chat's last frame.
 * `touch({ chatId, app, windowId, title })` after every desktop tool; `next({ chatId, after })` for viewers.
 */
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
    } catch {
      // A frame that can't be kept only costs the card its picture after a restart.
    }
  }

  const view = (state, live) => {
    const frame = state.frame;
    return frame ? { ...frame, live } : { seq: 0, live };
  };

  function publish(state, frame) {
    state.frame = frame;
    for (const waiter of state.waiters) waiter();
  }

  async function capture(chatId) {
    const state = feed(chatId);
    const target = state.target;
    if (!target) return;
    const args = ["screenshot", ...(target.windowId ? ["--window-id", target.windowId] : ["--app", target.app]), "--session", CAPTURE_SESSION];
    const envelope = await exec(args, { timeoutMs: 10_000 });
    const previous = state.frame;
    if (!envelope.ok) {
      const code = envelope.error?.code;
      // The window closed: fall back to the app's front window next time.
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
      state.timer = null;
      state.capturing = true;
      try {
        await capture(chatId);
      } finally {
        state.capturing = false;
      }
      if (now() - state.lastActive < idle) schedule(chatId);
      else {
        persist(chatId, state.frame);
        for (const waiter of state.waiters) waiter();
      }
    }, interval);
  }

  /** An agent read or acted on `app` (its window `windowId` when known): show it, and keep capturing for a while. */
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

  /** The Chat's frame after `after`, waiting up to `timeoutMs` for one while the feed is live. */
  function next({ chatId, after = 0, timeoutMs = WAIT_MS }) {
    if (typeof chatId !== "string" || !chatId) throw new Error("Name the Chat.");
    const state = feed(chatId);
    if ((state.frame?.seq ?? 0) > after || !live(chatId)) return Promise.resolve(view(state, live(chatId)));
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
    if (!state) return;
    if (state.timer) clearTimer(state.timer);
    for (const waiter of state.waiters) waiter();
    feeds.delete(chatId);
  }

  return { touch, next, live, forget };
}

module.exports = { createScreenFeed, CAPTURE_SESSION };

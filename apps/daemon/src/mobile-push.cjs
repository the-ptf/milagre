const { preparePrivateDirectory, assertPrivate } = require("@milagre/core/private-files");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { attentionNotice, completionNotice } = require("@milagre/shared/attention");
const { isTurnEnd, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { createActivityTracker } = require("@milagre/shared/chat-activity");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { notificationChimeChannel, notificationChimeSound, parseNotificationChime } = require("@milagre/shared/notification-chimes");
const validOwner = (owner) => path.isAbsolute(owner) || isLinkScopeKey(owner);

const FOCUS_MS = 15000;
const MAX_DEVICES = 32;
const MAX_CHATS = 500;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN = /^(?:ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]{1,200}\]$/;
// A Mac reached through the public relay has no URL; the phone names it by its relay host id.
const RELAY_HOST = /^relay:\/\/[A-Za-z0-9_-]{22}$/;
const capped = (value, limit) =>
  String(value || "")
    .trim()
    .slice(0, limit);
function validDevice(deviceId) {
  if (typeof deviceId !== "string" || !UUID.test(deviceId)) throw new Error("Invalid push device ID");
  return deviceId;
}
function registration(value) {
  validDevice(value?.deviceId);
  if (typeof value.token !== "string" || !TOKEN.test(value.token)) throw new Error("Invalid Expo push token");
  if (!(typeof value.hostId === "string" && RELAY_HOST.test(value.hostId))) {
    let host;
    try {
      host = new URL(value.hostId);
    } catch {
      throw new Error("Invalid push computer address");
    }
    if (
      host.origin !== value.hostId ||
      host.username ||
      host.password ||
      value.hostId.length > 512 ||
      (host.protocol !== "https:" && !(host.protocol === "http:" && ["127.0.0.1", "10.0.2.2"].includes(host.hostname)))
    )
      throw new Error("Invalid push computer address");
  }
  if (typeof value.notifyWhenWaiting !== "boolean" || typeof value.notifyOnCompletion !== "boolean") throw new Error("Invalid push preferences");
  return {
    deviceId: value.deviceId,
    token: value.token,
    hostId: value.hostId,
    notifyWhenWaiting: value.notifyWhenWaiting,
    notifyOnCompletion: value.notifyOnCompletion,
    // The phone's Experimental chime, bundled in its build. Older phones send none: the system sound.
    chime: parseNotificationChime(value.chime),
  };
}

/**
 * The daemon owns registrations and event policy. Neither desktop nor a live phone connection is needed to deliver.
 * A Chat open in a focused desktop window (isChatFocused) is already being read, so no phone hears about it.
 */
function createMobilePush({ dataDir, send, context, isChatFocused = () => false, now = Date.now, onError = () => {} }) {
  const file = path.join(dataDir, "mobile-push.json");
  let devices = new Map();
  const focus = new Map();
  const chats = new Map();
  // What each chat is doing (chat-activity.mjs): its work ends when it leaves working or background for idle or failed,
  // so a turn that ends while background subagents work is announced only once they end with no turn to take the result.
  const activity = createActivityTracker({ maxChats: MAX_CHATS });
  const work = new Set();
  let writes = Promise.resolve();
  let epoch = 0;
  let closed = false;
  const report = () => {
    try {
      onError(new Error("Mobile notification delivery failed. Check push configuration and connectivity."));
    } catch {}
  };
  const ordered = (task) => {
    const next = writes.then(task);
    writes = next.catch(() => {});
    return next;
  };
  async function save(next) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") preparePrivateDirectory(dataDir);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify([...next.values()]), { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    devices = next;
  }
  function current(device, chatId) {
    const view = focus.get(device.deviceId);
    return !closed && devices.get(device.deviceId) === device && !(view?.chatId === chatId && view.until > now()) && !isChatFocused(chatId);
  }
  /** An approval or question (`requestId`), or with `completion` the end of the chat's work (chat-activity.mjs). */
  function deliver(chatId, run, event, requestId, completion) {
    if (!devices.size) return;
    const version = epoch;
    const eventId = randomUUID();
    const task = (async () => {
      const metadata = await context(chatId);
      const notice = requestId ? attentionNotice(event, metadata) : completionNotice(metadata.chatTitle, completion);
      const validEvent = () => epoch === version && chats.get(chatId) === run && (requestId ? !run.ended && run.requests.has(requestId) : run.ended);
      if (!notice || !validEvent()) return;
      for (const device of devices.values()) {
        if (!(requestId ? device.notifyWhenWaiting : device.notifyOnCompletion)) continue;
        const isCurrent = () => validEvent() && current(device, chatId);
        if (!isCurrent()) continue;
        const sending = Promise.resolve(
          send(
            {
              to: device.token,
              title: capped(notice.title, 120),
              body: capped(notice.body, 240),
              sound: notificationChimeSound(device.chime),
              channelId: notificationChimeChannel(device.chime),
              ttl: 300,
              data: { kind: "milagre-chat", hostId: device.hostId, projectPath: projectOfKey(chatId), sessionId: sessionIdFromKey(chatId), eventId },
            },
            isCurrent,
          ),
        ).catch(report);
        work.add(sending);
        void sending.finally(() => work.delete(sending));
      }
    })().catch(report);
    work.add(task);
    void task.finally(() => work.delete(task));
  }
  return {
    async load() {
      try {
        const values = JSON.parse(await fs.readFile(file, "utf8"));
        if (!Array.isArray(values) || values.length > MAX_DEVICES) throw new Error("Invalid push registry");
        devices = new Map(
          values.map((value) => {
            const device = registration(value);
            return [device.deviceId, device];
          }),
        );
      } catch (error) {
        if (error.code !== "ENOENT") report();
      }
    },
    async register(value) {
      const device = registration(value);
      return ordered(async () => {
        if (closed) throw new Error("Push service is closing");
        if (!devices.has(device.deviceId) && devices.size >= MAX_DEVICES) throw new Error("Too many registered push devices");
        const previous = devices.get(device.deviceId);
        if (previous && JSON.stringify(previous) === JSON.stringify(device)) return { registered: true };
        const next = new Map(devices);
        // A token represents one app installation. A reinstallation must not get two copies.
        for (const [id, old] of next)
          if (old.token === device.token) {
            next.delete(id);
            focus.delete(id);
          }
        next.set(device.deviceId, device);
        await save(next);
        return { registered: true };
      });
    },
    unregister({ deviceId } = {}) {
      validDevice(deviceId);
      return ordered(async () => {
        const next = new Map(devices);
        next.delete(deviceId);
        focus.delete(deviceId);
        await save(next);
        return { registered: false };
      });
    },
    invalidate(token) {
      return ordered(async () => {
        const next = new Map(devices);
        for (const [id, device] of next)
          if (device.token === token) {
            next.delete(id);
            focus.delete(id);
          }
        await save(next);
      });
    },
    focus({ deviceId, chatId } = {}) {
      validDevice(deviceId);
      if (!devices.has(deviceId)) throw new Error("Push device is not registered");
      if (
        chatId !== null &&
        (typeof chatId !== "string" ||
          chatId.length > 4096 ||
          !Number.isSafeInteger(sessionIdFromKey(chatId)) ||
          sessionIdFromKey(chatId) < 1 ||
          !validOwner(projectOfKey(chatId)))
      )
        throw new Error("Invalid focused Chat");
      if (chatId === null) focus.delete(deviceId);
      else focus.set(deviceId, { chatId, until: now() + FOCUS_MS });
      return null;
    },
    observe(chatId, event) {
      if (closed || !Number.isSafeInteger(sessionIdFromKey(chatId)) || !validOwner(projectOfKey(chatId))) return;
      let run = chats.get(chatId);
      // A turn started again under the same id (a steer that reached it) keeps its lifecycle and what it followed.
      const repeated = event.type === "turn-started" && event.turnId && run?.turnId === event.turnId && !run.ended;
      const { completion } = repeated ? { completion: null } : activity.observe(chatId, event);
      if (event.type === "turn-started" || (event.type === "message-sent" && run?.ended)) {
        if (repeated) return;
        run = { requests: new Set(), seen: new Set(), ended: false, turnId: event.turnId };
        chats.delete(chatId);
        chats.set(chatId, run);
      }
      if (!run) {
        run = { requests: new Set(), seen: new Set(), ended: false };
        chats.set(chatId, run);
      }
      if (chats.size > MAX_CHATS) chats.delete(chats.keys().next().value);
      if (isTurnEnd(event) && !run.ended) {
        run.ended = true;
        run.requests.clear();
      }
      if (completion) deliver(chatId, run, null, undefined, completion);
      if (event.type === "permission-request" || event.type === "question-request") {
        if (run.ended || typeof event.requestId !== "string" || run.seen.has(event.requestId) || run.seen.size >= 100) return;
        run.seen.add(event.requestId);
        run.requests.add(event.requestId);
        deliver(chatId, run, event, event.requestId);
      } else if (event.type === "permission-resolved" || event.type === "question-resolved") {
        run.requests.delete(event.requestId);
        run.seen.add(event.requestId);
      }
    },
    async clear() {
      epoch++;
      focus.clear();
      return ordered(async () => {
        await save(new Map());
      });
    },
    async settled() {
      while (work.size) await Promise.all([...work]);
      await writes;
    },
    async close() {
      closed = true;
      epoch++;
      focus.clear();
      await writes;
    },
  };
}
module.exports = { createMobilePush, FOCUS_MS };

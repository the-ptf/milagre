const { isTurnEnd: isTerminal } = require("@milagre/shared/agent-runs");
const { computerOfKey } = require("@milagre/shared/chat-scopes");
const { completionNotice, notificationText } = require("@milagre/shared/attention");
const { createActivityTracker } = require("@milagre/shared/chat-activity");
const { parseNotificationChime } = require("@milagre/shared/notification-chimes");

const { notificationAllowed, parseNotificationSchedule } = require("@milagre/shared/notification-schedule");
const { thisComputer } = require("@milagre/shared/host-computer");

const MAX_TITLE = 120;

const capped = (value, max) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const keyOf = (chatId, requestId) => `${chatId}\n${requestId}`;

// System notifications for chats that wait on the user: an approval or a question. Every agent event
// is observed, so the notifier knows which requests are still open, and notify names the chat. One shows only while no Milagre window has focus, once per
// request, and closes when its request is answered or its turn ends. Clicking it opens the chat.
// The end of a chat's work is announced too (notifyCompletion): the chat leaving working or background for idle or
// failed, as the shared activity tracker (chat-activity.mjs) tells it. A turn that ends while the chat's background
// subagents work is not that end: the window's call is kept, and announced once the work ends.
// A chat's notification plays the chime picked in Settings > Notifications: the system notice goes silent and playChime
// plays the clip in the window. With no window to play it (playChime returns false), the system sound stays.
class AttentionNotifier {
  /** @param {{ createNotification: (notice: {title: string; subtitle: string; body: string; silent?: boolean}) => Electron.Notification; isAppFocused: () => boolean; openChat: (chatId: string) => void; openPhoneSettings?: () => void; setBadge?: (badge: string) => void; canPlayChime?: () => boolean; playChime?: (chime: string) => void; now?: () => number }} options */
  constructor({
    createNotification,
    isAppFocused,
    openChat,
    openPhoneSettings = () => {},
    setBadge = () => {},
    canPlayChime = () => false,
    playChime = () => {},
    now = Date.now,
  }) {
    this.createNotification = createNotification;
    this.now = now;
    this.schedule = null;
    this.canPlayChime = canPlayChime;
    this.playChime = playChime;
    this.chime = "system";
    this.isAppFocused = isAppFocused;
    this.openChat = openChat;
    this.openPhoneSettings = openPhoneSettings;
    this.setBadge = setBadge;
    /** @type {Electron.Notification | null} */
    this.phonePaired = null;
    /** @type {Electron.Notification | null} */
    this.computerWaiting = null;
    // Keys of the computers waiting for Allow that were already announced.
    this.computersAnnounced = new Set();
    // What each chat is doing, from its events, and the ends of work no window has asked to announce yet.
    this.activity = createActivityTracker();
    this.completed = new Map();
    this.completionNotifications = new Map();
    this.unread = new Set();
    /** @type {string | null} */
    this.activeChatId = null;
    this.notifyOnCompletion = true;
    this.showDockBadge = true;
    // Requests the agents wait on, by key, with the notification shown for each (or null).
    this.open = new Map();
    // Chats a window asked to announce whose work goes on in the background, with the title to announce it by.
    this.asked = new Map();
  }

  /** @param {{ projectPath?: string; activeChatId?: string | null; unread?: string[]; notifyOnCompletion?: boolean; showDockBadge?: boolean }} [state] */
  sync({ projectPath, activeChatId = null, unread = [], notifyOnCompletion = true, showDockBadge = true } = {}) {
    this.activeChatId = typeof activeChatId === "string" ? activeChatId : null;
    this.notifyOnCompletion = notifyOnCompletion === true;
    this.showDockBadge = showDockBadge === true;
    if (typeof projectPath === "string") {
      const prefix = `${projectPath}#`;
      for (const id of this.unread) if (id.startsWith(prefix)) this.unread.delete(id);
      if (Array.isArray(unread)) for (const id of unread) if (typeof id === "string" && id.startsWith(prefix)) this.unread.add(id);
      for (const [id, notification] of this.completionNotifications) {
        if (id.startsWith(prefix) && !this.unread.has(id)) {
          notification.close();
          this.completionNotifications.delete(id);
        }
      }
    }
    this.updateBadge();
  }

  /** @param {unknown} chime */
  setChime(chime) {
    this.chime = parseNotificationChime(chime);
  }

  setSchedule(value) {
    this.schedule = parseNotificationSchedule(value);
  }

  /** A chat's notification, silent when the window plays the chime instead; show() it, then call the returned `played`. */
  chatNotification(notice) {
    const chime = this.chime !== "system" && this.canPlayChime() ? this.chime : null;
    const notification = this.createNotification(chime ? { ...notice, silent: true } : notice);
    return { notification, played: () => chime && this.playChime(chime) };
  }

  updateBadge() {
    const chats = new Set(this.unread);
    for (const key of this.open.keys()) chats.add(key.slice(0, key.lastIndexOf("\n")));
    this.setBadge(this.showDockBadge && chats.size ? String(chats.size) : "");
  }

  observe(chatId, event) {
    const { completion } = this.activity.observe(chatId, event);
    // A new turn announces its own end; so does the turn a background subagent's result wakes.
    if (event.type === "turn-started" || event.type === "turn-cancelled") {
      this.completed.delete(chatId);
      this.asked.delete(chatId);
    }
    if (completion) {
      const result = { failed: completion.failed, body: completion.body };
      const asked = this.asked.has(chatId);
      const title = this.asked.get(chatId);
      this.asked.delete(chatId);
      if (asked) {
        if (this.notifyOnCompletion) this.showCompletion(chatId, title, result);
      } else {
        this.completed.set(chatId, result);
        if (this.completed.size > 100) this.completed.delete(this.completed.keys().next().value);
      }
    }
    if (event.type === "permission-request" || event.type === "question-request") {
      const key = keyOf(chatId, event.requestId);
      if (!this.open.has(key)) this.open.set(key, null);
    } else if (event.type === "permission-resolved" || event.type === "question-resolved") {
      this.close(keyOf(chatId, event.requestId));
    } else if (isTerminal(event)) {
      for (const key of Array.from(this.open.keys())) if (key.startsWith(`${chatId}\n`)) this.close(key);
    }
    this.updateBadge();
  }

  // Only a request an agent still waits on is notified about.
  /** @param {{ chatId?: string; requestId?: string; title?: string; body?: string }} [notice] */
  notify({ chatId, requestId, title, body } = {}) {
    const key = keyOf(String(chatId), String(requestId));
    if (!this.open.has(key) || this.open.get(key) || this.isAppFocused() || !notificationAllowed(this.schedule, this.now())) return false;
    const { notification, played } = this.chatNotification({
      title: capped(title, MAX_TITLE) || "Milagre",
      subtitle: "",
      body: notificationText(body, { markdown: false }),
    });
    notification.on("click", () => this.openChat(String(chatId)));
    this.open.set(key, notification);
    notification.show();
    played();
    return true;
  }

  /** @param {{ chatId?: string; title?: string }} [notice] */
  notifyCompletion({ chatId, title } = {}) {
    if (typeof chatId !== "string") return false;
    const result = this.completed.get(chatId);
    this.completed.delete(chatId);
    // The turn ended, but the chat's background subagents still work: its work ends when they do (see observe).
    if (!result && this.activity.activity(chatId) === "background") this.asked.set(chatId, title);
    if (!result || !this.notifyOnCompletion) return false;
    return this.showCompletion(chatId, title, result);
  }

  showCompletion(chatId, title, result) {
    if (!notificationAllowed(this.schedule, this.now())) return false;
    if (this.isAppFocused() && this.activeChatId === chatId) return false;
    const notice = completionNotice(title, result);
    const { notification, played } = this.chatNotification({
      title: capped(notice.title, MAX_TITLE),
      subtitle: "",
      body: notice.body,
    });
    this.completionNotifications.get(chatId)?.close();
    this.completionNotifications.set(chatId, notification);
    notification.on("click", () => this.openChat(chatId));
    notification.show();
    played();
    return true;
  }

  // A device paired with this Mac for the first time: a phone, or ("computer") another Mac that can now drive this one.
  // Shown even while Milagre has focus: it is about who can reach the agents, and the pairing window opens just by
  // looking at Settings → Devices. Clicking it opens that page.
  notifyDevicePaired(kind = "phone") {
    if (kind !== "computer") return this.notifyPhonesPaired([{ name: null }]);
    return this.showPaired({
      title: "New computer paired",
      subtitle: "",
      body: `Another computer can now drive your agents on ${thisComputer}. If it wasn't you, remove it in Settings → Devices.`,
    });
  }

  /**
   * Phones that paired with this Mac and no window announced yet (devices:take-notices), named when they sent a name.
   * `away`: they paired while this desktop wasn't connected (Milagre was closed), so the notice says so.
   * @param {Array<{ name?: unknown }>} phones
   * @param {{ away?: boolean }} [options]
   */
  notifyPhonesPaired(phones, { away = false } = {}) {
    const list = Array.isArray(phones) ? phones : [];
    if (!list.length) return false;
    const name = list.length === 1 ? capped(list[0]?.name, 60) : "";
    const who = list.length === 1 ? name || "A phone" : `${list.length} phones`;
    const removeIt = list.length === 1 ? "If it wasn't you, remove it in Settings → Devices." : "If one wasn't you, remove it in Settings → Devices.";
    return this.showPaired({
      title: list.length === 1 ? "New phone paired" : `${list.length} new phones paired`,
      subtitle: "",
      body: away
        ? `${who} paired with ${thisComputer} while Milagre was closed. ${removeIt}`
        : `${who} can now reach your agents on ${thisComputer}. ${removeIt}`,
    });
  }

  /** @param {{ title: string; subtitle: string; body: string }} notice */
  showPaired(notice) {
    const notification = this.createNotification(notice);
    this.phonePaired?.close();
    this.phonePaired = notification;
    notification.on("click", () => this.openPhoneSettings());
    notification.show();
    return true;
  }

  /**
   * Computers waiting for Allow (devices:pending): a new one is announced once, while no Milagre window has focus (the
   * prompt is on screen otherwise). The notice closes when nothing waits any more; its click brings the window back.
   * @param {Array<{ key?: unknown; name?: unknown }>} [requests]
   */
  notifyComputerWaiting(requests = []) {
    const waiting = (Array.isArray(requests) ? requests : []).filter((request) => typeof request?.key === "string");
    const keys = new Set(waiting.map((request) => /** @type {string} */ (request.key)));
    for (const key of this.computersAnnounced) if (!keys.has(key)) this.computersAnnounced.delete(key);
    if (!keys.size) {
      this.computerWaiting?.close();
      this.computerWaiting = null;
      return false;
    }
    const fresh = waiting.find((request) => !this.computersAnnounced.has(/** @type {string} */ (request.key)));
    for (const key of keys) this.computersAnnounced.add(key);
    if (!fresh || this.isAppFocused()) return false;
    const name = capped(fresh.name, MAX_TITLE) || "A computer";
    const notification = this.createNotification({
      title: `${name} wants to drive ${thisComputer}'s chats`,
      subtitle: "",
      body: "Open Milagre to allow or deny it.",
    });
    this.computerWaiting?.close();
    this.computerWaiting = notification;
    notification.on("click", () => this.openPhoneSettings());
    notification.show();
    return true;
  }

  close(key) {
    const notification = this.open.get(key);
    this.open.delete(key);
    notification?.close();
  }

  /** A computer was removed or switched off: what it waited on, and its unread chats, leave the badge. */
  forgetComputer(computerId) {
    const mine = (chatId) => computerOfKey(chatId) === computerId;
    for (const key of Array.from(this.open.keys())) if (mine(key.slice(0, key.lastIndexOf("\n")))) this.close(key);
    for (const chatId of this.unread) if (mine(chatId)) this.unread.delete(chatId);
    for (const [chatId, notification] of Array.from(this.completionNotifications)) {
      if (!mine(chatId)) continue;
      notification.close();
      this.completionNotifications.delete(chatId);
    }
    for (const map of [this.completed, this.asked]) for (const chatId of map.keys()) if (mine(chatId)) map.delete(chatId);
    this.activity.forget(mine);
    this.updateBadge();
  }

  closeAll() {
    for (const key of Array.from(this.open.keys())) this.close(key);
    for (const notification of this.completionNotifications.values()) notification.close();
    this.completionNotifications.clear();
    this.computerWaiting?.close();
    this.computerWaiting = null;
    this.completed.clear();
    this.asked.clear();
    this.activity.forget();
    this.setBadge("");
  }
}

module.exports = { AttentionNotifier };

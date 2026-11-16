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

class AttentionNotifier {
  /** @param {{ createNotification: (notice: {title: string; subtitle: string; body: string; silent?: boolean}) => Electron.Notification; isAppFocused: () => boolean; openChat: (chatId: string) => void; openPhoneSettings?: () => void; setBadge?: (badge: string) => void; canPlayChime?: () => boolean; playChime?: (chime: string) => void; isHidden?: (chatId: string) => boolean; now?: () => number }} options */
  constructor({
    createNotification,
    isAppFocused,
    isHidden = () => false,
    openChat,
    openPhoneSettings = () => {},
    setBadge = () => {},
    canPlayChime = () => false,
    playChime = () => {},
    now = Date.now,
  }) {
    this.createNotification = createNotification;
    this.isHidden = isHidden;
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
    this.computersAnnounced = new Set();
    this.activity = createActivityTracker();
    this.completed = new Map();
    this.completionNotifications = new Map();
    this.unread = new Set();
    /** @type {string | null} */
    this.activeChatId = null;
    this.notifyOnCompletion = true;
    this.showDockBadge = true;
    this.open = new Map();
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

  chatNotification(notice) {
    const chime = this.chime !== "system" && this.canPlayChime() ? this.chime : null;
    const notification = this.createNotification(chime ? { ...notice, silent: true } : notice);
    return { notification, played: () => chime && this.playChime(chime) };
  }

  updateBadge() {
    const chats = new Set([...this.unread].filter((chatId) => !this.isHidden(chatId)));
    for (const key of this.open.keys()) {
      const chatId = key.slice(0, key.lastIndexOf("\n"));
      if (!this.isHidden(chatId)) chats.add(chatId);
    }
    this.setBadge(this.showDockBadge && chats.size ? String(chats.size) : "");
  }

  observe(chatId, event) {
    const { completion } = this.activity.observe(chatId, event);
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

  /** @param {{ chatId?: string; requestId?: string; title?: string; body?: string }} [notice] */
  notify({ chatId, requestId, title, body } = {}) {
    const key = keyOf(String(chatId), String(requestId));
    if (!this.open.has(key) || this.open.get(key) || this.isHidden(String(chatId)) || this.isAppFocused() || !notificationAllowed(this.schedule, this.now()))
      return false;
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
    if (!result && this.activity.activity(chatId) === "background") this.asked.set(chatId, title);
    if (!result || !this.notifyOnCompletion) return false;
    return this.showCompletion(chatId, title, result);
  }

  showCompletion(chatId, title, result) {
    if (this.isHidden(chatId) || !notificationAllowed(this.schedule, this.now())) return false;
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

  notifyDevicePaired(kind = "phone") {
    if (kind !== "computer") return this.notifyPhonesPaired([{ name: null }]);
    return this.showPaired({
      title: "New computer paired",
      subtitle: "",
      body: `Another computer can now drive your agents on ${thisComputer}. If it wasn't you, remove it in Settings → Phone & sharing.`,
    });
  }

  /**
   * @param {Array<{ name?: unknown }>} phones
   * @param {{ away?: boolean }} [options]
   */
  notifyPhonesPaired(phones, { away = false } = {}) {
    const list = Array.isArray(phones) ? phones : [];
    if (!list.length) return false;
    const name = list.length === 1 ? capped(list[0]?.name, 60) : "";
    const who = list.length === 1 ? name || "A phone" : `${list.length} phones`;
    const removeIt =
      list.length === 1 ? "If it wasn't you, remove it in Settings → Phone & sharing." : "If one wasn't you, remove it in Settings → Phone & sharing.";
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

  hiddenChanged() {
    for (const [key, notification] of this.open) {
      if (notification && this.isHidden(key.slice(0, key.lastIndexOf("\n")))) {
        notification.close();
        this.open.set(key, null);
      }
    }
    for (const [chatId, notification] of Array.from(this.completionNotifications)) {
      if (!this.isHidden(chatId)) continue;
      notification.close();
      this.completionNotifications.delete(chatId);
    }
    this.updateBadge();
  }

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

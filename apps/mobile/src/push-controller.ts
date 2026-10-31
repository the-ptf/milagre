import type { SavedHost } from "./hosts-store.ts";
import type { PushPreferences, PushStore } from "./push-store.ts";
import { isChatScope } from "./chat-scope.ts";
import { parseNotificationChime } from "@milagre/shared/notification-chimes";

export type PushView = { hostId: string; chatId: string } | null;
export type NotificationTarget = { host: SavedHost; projectPath: string; sessionId: number; eventId: string };
export function notificationTarget(value: unknown, hosts: SavedHost[]): NotificationTarget | null {
  const data = value as Record<string, unknown> | null;
  if (
    !data ||
    data.kind !== "milagre-chat" ||
    typeof data.hostId !== "string" ||
    !isChatScope(data.projectPath) ||
    data.projectPath.length > 4096 ||
    data.projectPath.includes("\0") ||
    !Number.isSafeInteger(data.sessionId) ||
    Number(data.sessionId) < 1 ||
    typeof data.eventId !== "string" ||
    data.eventId.length > 128
  )
    return null;
  const host = hosts.find((host) => host.id === data.hostId);
  return host ? { host, projectPath: data.projectPath, sessionId: Number(data.sessionId), eventId: data.eventId } : null;
}
// The routes app/_layout.tsx presents as a sheet or a transparent modal: the Chat they open over stays on screen behind
// them. A full-screen modal or a pushed page hides it.
export const SHEETS_OVER_CHAT = new Set([
  "update-sheet",
  "update-notes",
  "confirm-sheet",
  "choice-sheet",
  "chime-sheet",
  "add-computer",
  "mcp-add",
  "link-projects",
  "link-chat",
  "choose-projects",
  "context-sheet",
  "permission-sheet",
  "model-sheet",
  "agents",
  "inbox",
  "ports-sheet",
  "browser-sheet",
  "activity",
  "background",
  "handoff-brief",
  "routine-form",
  "viewer",
]);
// Every page inside the Settings sheet (app/(settings)): the group is one sheet in the layout, so its pages share the
// sheet's rule. A sheet that opens over the Chat leaves it viewed.
const SETTINGS_SHEET_PAGES = new Set([
  "settings",
  "computers",
  "computer",
  "general",
  "accounts",
  "project-accounts",
  "connections",
  "appearance",
  "chat-display",
  "notifications",
  "usage",
  "skills",
  "skill",
  "mcp",
  "mcp-server",
  "local-mcp",
  "experimental",
  "project-settings",
  "published-pages",
]);
// Sheets the layout presents over a full-screen page (the designs), which already hides the Chat: they don't keep it viewed.
export const SHEETS_OVER_PAGES = new Set(["design-share-sheet"]);
/** The Chat on screen: the one at /chat (`chat`), or the one a sheet opened over (`previous`), while its computer is connected. */
export function viewedChat(path: string, chat: PushView, previous: PushView, connected: string | undefined): PushView {
  if (path === "/chat") return chat;
  return previous && previous.hostId === connected && (SHEETS_OVER_CHAT.has(path.slice(1)) || SETTINGS_SHEET_PAGES.has(path.slice(1))) ? previous : null;
}
export function shouldPresentNotification(value: unknown, view: PushView) {
  const data = value as Record<string, unknown> | null;
  return !(view && data?.kind === "milagre-chat" && data.hostId === view.hostId && `${data.projectPath}#${data.sessionId}` === view.chatId);
}

type Native = { available(): string; permission(): Promise<boolean>; requestPermission(): Promise<boolean>; token(): Promise<string> };
type Dependencies = {
  store: PushStore;
  hosts(): Promise<SavedHost[]>;
  forgetHost?(host: SavedHost): Promise<void>;
  native: Native;
  call(host: SavedHost, method: string, args: unknown[]): Promise<unknown>;
  onError?(message: string): void;
};
export function createPushController({ store, hosts, forgetHost = async () => {}, native, call, onError = () => {} }: Dependencies) {
  let version = 0;
  let work: Promise<unknown> = Promise.resolve();
  const forgotten = new Map<string, SavedHost>();
  let viewed: PushView = null;
  const ordered = <T>(task: () => Promise<T>) => {
    const next = work.then(task);
    work = next.catch(() => {});
    return next;
  };
  async function drain() {
    const state = await store.read();
    for (const host of state.pending) {
      if (host.forgotten) await forgetHost(host);
      // Re-pairing can rotate the bridge credential while keeping the same address.
      const current = (await hosts()).find((item) => item.id === host.id) || host;
      try {
        await call(current, "push:unregister", [{ deviceId: state.deviceId }]);
        await store.unregistered(host);
      } catch {
        onError(`Notifications may continue from ${host.name} until it reconnects. Removal will retry when you open Milagre.`);
      }
    }
  }
  async function sync(current: number) {
    await drain();
    const state = await store.read();
    if (!state.enabled || !state.token || current !== version) return;
    const saved = await hosts();
    for (const host of saved) {
      if (current !== version) return;
      const removed = forgotten.get(host.id);
      if (removed && removed.token === host.token && removed.lastUsed === host.lastUsed) continue;
      if (state.pending.some((item) => item.id === host.id)) continue;
      // Save before sending: a timeout can mean the daemon accepted registration but its reply was lost.
      await store.registered(host);
      if (current !== version) return;
      try {
        if (state.schedule) {
          const status = (await call(host, "daemon:status", [])) as { capabilities?: string[] } | null;
          if (!status?.capabilities?.includes("mobile-push-schedule-v1")) {
            await call(host, "push:unregister", [{ deviceId: state.deviceId }]);
            onError(`Update Milagre on ${host.name} to use notification schedules. Notifications from it are paused until it supports your schedule.`);
            continue;
          }
        }
        await call(host, "push:register", [
          {
            deviceId: state.deviceId,
            token: state.token,
            hostId: host.id,
            notifyWhenWaiting: state.notifyWhenWaiting,
            notifyOnCompletion: state.notifyOnCompletion,
            chime: parseNotificationChime(state.chime),
            schedule: state.schedule ?? null,
          },
        ]);
      } catch {
        onError(`Could not enable notifications from ${host.name}. Check that it is online and running the latest Milagre. Registration will retry.`);
      }
    }
  }
  const controller = {
    async enable() {
      const current = ++version;
      const unavailable = native.available();
      if (unavailable) throw new Error(unavailable);
      if (!(await native.requestPermission())) throw new Error("Notifications are off in system Settings. Allow notifications for Milagre, then try again.");
      const token = await native.token();
      await ordered(async () => {
        if (current !== version) return;
        await store.update({ enabled: true, token });
        await sync(current);
      });
    },
    disable() {
      version++;
      return ordered(async () => {
        await store.disable();
        viewed = null;
        await drain();
      });
    },
    preferences(preferences: Partial<PushPreferences>) {
      return ordered(async () => {
        await store.update(preferences);
        await sync(version);
      });
    },
    async refresh() {
      const current = version;
      const state = await store.read();
      if (!state.enabled) {
        await ordered(drain);
        return;
      }
      if (native.available()) return;
      if (!(await native.permission())) {
        if (current === version) await controller.disable();
        return;
      }
      const token = await native.token();
      await ordered(async () => {
        if (current !== version) return;
        await store.update({ token });
        await sync(current);
      });
    },
    forget(host: SavedHost) {
      version++;
      forgotten.set(host.id, host);
      // Secure storage is ordered separately. Local Forget must never wait on a network call.
      return store.forget(host);
    },
    focus(view: PushView) {
      return ordered(async () => {
        const state = await store.read();
        const previous = viewed;
        viewed = view;
        if (!state.enabled) return;
        if (previous && previous.hostId !== view?.hostId) {
          const old = state.registered.find((host) => host.id === previous.hostId);
          if (old) await call(old, "push:focus", [{ deviceId: state.deviceId, chatId: null }]).catch(() => {});
        }
        if (view) {
          const host = state.registered.find((host) => host.id === view.hostId);
          if (host) await call(host, "push:focus", [{ deviceId: state.deviceId, chatId: view.chatId }]).catch(() => {});
        }
      });
    },
  };
  return controller;
}

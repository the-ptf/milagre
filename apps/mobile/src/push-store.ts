import type { SavedHost } from "./hosts-store.ts";
import type { NotificationChime } from "@milagre/shared/notification-chimes";

import { parseNotificationSchedule, type NotificationSchedule } from "@milagre/shared/notification-schedule";

/** `chime` is the notification chime; state saved before it existed has none, read as the system sound. */
export type PushPreferences = { notifyWhenWaiting: boolean; notifyOnCompletion: boolean; chime?: NotificationChime; schedule?: NotificationSchedule | null };
export type PushState = PushPreferences & {
  deviceId: string;
  enabled: boolean;
  token: string | null;
  registered: SavedHost[];
  pending: (SavedHost & { forgotten?: boolean })[];
};
type Storage = { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void> };
const KEY = "milagre.push.v1";
const unique = <T extends SavedHost>(hosts: T[]) => [...new Map(hosts.map((host) => [host.id, host])).values()];

/** Includes attempted registrations: even a lost RPC acknowledgement needs an unregister on Disable or Forget. */
export function createPushStore(storage: Storage, newId: () => string) {
  let state: PushState | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  function ordered<T>(task: () => Promise<T>): Promise<T> {
    const result = writes.then(task);
    writes = result.catch(() => {});
    return result;
  }
  async function read() {
    if (!state) {
      const saved = await storage.getItemAsync(KEY);
      if (saved !== null) {
        const value = JSON.parse(saved) as PushState;
        if (typeof value.deviceId !== "string" || typeof value.enabled !== "boolean" || !Array.isArray(value.registered) || !Array.isArray(value.pending))
          throw new Error("Could not read notification settings.");
        state = { ...value, schedule: parseNotificationSchedule(value.schedule) };
      } else {
        const initial: PushState = {
          deviceId: newId(),
          enabled: false,
          notifyWhenWaiting: true,
          notifyOnCompletion: true,
          token: null,
          registered: [],
          pending: [],
        };
        await storage.setItemAsync(KEY, JSON.stringify(initial));
        state = initial;
      }
    }
    return { ...state, registered: [...state.registered], pending: [...state.pending] };
  }
  async function write(next: PushState) {
    await storage.setItemAsync(KEY, JSON.stringify(next));
    state = next;
    return read();
  }
  return {
    read: () => ordered(read),
    update: (value: Partial<Pick<PushState, "enabled" | "token" | "notifyWhenWaiting" | "notifyOnCompletion" | "chime" | "schedule">>) =>
      ordered(async () => write({ ...(await read()), ...value })),
    registered: (host: SavedHost) =>
      ordered(async () => {
        const old = await read();
        return write({ ...old, registered: unique([...old.registered, host]) });
      }),
    forget: (host: SavedHost) =>
      ordered(async () => {
        const old = await read();
        return write({
          ...old,
          registered: old.registered.filter((item) => item.id !== host.id),
          pending: unique([...old.pending, { ...host, forgotten: true }]),
        });
      }),
    unregistered: (host: SavedHost) =>
      ordered(async () => {
        const old = await read();
        return write({ ...old, pending: old.pending.filter((item) => item.id !== host.id || item.token !== host.token) });
      }),
    disable: () =>
      ordered(async () => {
        const old = await read();
        return write({ ...old, enabled: false, registered: [], pending: unique([...old.registered, ...old.pending]) });
      }),
  };
}
export type PushStore = ReturnType<typeof createPushStore>;

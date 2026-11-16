import { parseDevicePins, setPin, type DevicePins } from "@milagre/shared/chat-pins";

type Storage = { getItemAsync: (key: string) => Promise<string | null>; setItemAsync: (key: string, value: string) => Promise<void> };
type Sessions = Iterable<{ id: number; pinned?: boolean; pin_order?: number }>;
const keyPrefix = "milagre.chat-pins.v1.";
// As project-order-store: some iOS releases refused SecureStore values above about 2048 bytes.
const MAX_BYTES = 1900;
const NONE: DevicePins = Object.freeze({});

function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function keyFor(hostId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < hostId.length; i++) hash = Math.imul(hash ^ hostId.charCodeAt(i), 0x01000193) >>> 0;
  return `${keyPrefix}${hash.toString(16)}`;
}

export function boundedPins(hostId: string, pins: DevicePins): DevicePins {
  const scopes = Object.entries(pins);
  const size = (list: typeof scopes) => utf8Length(JSON.stringify({ h: hostId, p: Object.fromEntries(list) }));
  while (scopes.length > 1 && size(scopes) > MAX_BYTES) scopes.shift();
  return Object.fromEntries(scopes);
}

function parse(raw: string | null, hostId: string): DevicePins {
  try {
    const value = JSON.parse(raw || "null");
    return value && value.h === hostId ? parseDevicePins(value.p) : {};
  } catch {
    return {};
  }
}

export function createChatPinsStore(storage: Storage) {
  const pins = new Map<string, DevicePins>();
  const loading = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => {
    version++;
    listeners.forEach((listener) => listener());
  };
  let pending = Promise.resolve();
  const save = (hostId: string, value: DevicePins) => {
    pending = pending.then(() => storage.setItemAsync(keyFor(hostId), JSON.stringify({ h: hostId, p: value }))).catch(() => {});
    return pending;
  };
  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
    pins: (hostId: string): DevicePins => pins.get(hostId) ?? NONE,
    load(hostId: string): Promise<void> {
      if (pins.has(hostId)) return Promise.resolve();
      let work = loading.get(hostId);
      if (!work) {
        work = storage
          .getItemAsync(keyFor(hostId))
          .catch(() => null)
          .then((raw) => {
            if (pins.has(hostId)) return undefined;
            pins.set(hostId, parse(raw, hostId));
            notify();
            return undefined;
          });
        loading.set(hostId, work);
      }
      return work;
    },
    async set(hostId: string, scope: string, sessions: Sessions, id: number, order: number | null) {
      await store.load(hostId);
      const changed = setPin(pins.get(hostId) ?? NONE, scope, sessions, id, order);
      const { [scope]: mine, ...rest } = changed;
      const next = boundedPins(hostId, { ...rest, [scope]: mine! });
      pins.set(hostId, next);
      notify();
      return save(hostId, next);
    },
  };
  return store;
}

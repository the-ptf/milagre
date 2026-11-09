import { localEndpoint, relayAddress, validAccess, validRelay, type Access, type RelayLink } from "./client.ts";
import { validLanRoute, type LanRoute } from "./lan-route.ts";

/** A paired computer. A relay computer's `address` and `id` are `relay://<hostId>`; it has no URL of its own. */
export type SavedHost = {
  id: string;
  name: string;
  address: string;
  token: string;
  access?: Access;
  relay?: RelayLink;
  routes?: { lan?: LanRoute };
  /** Left out of the sidebar's Chat list (Settings › Computers); the pairing stays. */
  hidden?: boolean;
  lastUsed: number;
};
type SecureStorage = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};
const hostsKey = "milagre.hosts.v1";
const legacyKey = "milagre.connection.v1";
const MAX_HOSTS = 12;

function validate(value: unknown): SavedHost {
  const host = value as Partial<SavedHost>;
  if (!/^[a-f0-9]{64}$/i.test(String(host?.token ?? ""))) throw new Error("A saved computer has no valid token.");
  const lastUsed = Number(host.lastUsed) || 0;
  const lan = validLanRoute((host as { routes?: { lan?: unknown } }).routes?.lan);
  const routes = lan ? { routes: { lan } } : {};
  const hidden = host.hidden === true ? { hidden: true } : {};
  if (host.relay) {
    const relay = validRelay(host.relay);
    const address = relayAddress(relay.hostId);
    return { id: address, name: String(host.name || "Mac").slice(0, 80), address, token: String(host.token), relay, ...routes, ...hidden, lastUsed };
  }
  const address = localEndpoint(String(host?.address ?? ""));
  const access = validAccess(host.access);
  return {
    id: address,
    name: String(host.name || new URL(address).hostname).slice(0, 80),
    address,
    token: String(host.token),
    ...(access ? { access } : {}),
    ...routes,
    ...hidden,
    lastUsed,
  };
}
const sorted = (hosts: SavedHost[]) => [...hosts].sort((a, b) => b.lastUsed - a.lastUsed);

/** Every computer the phone has paired with, newest first. One entry per address; the token lives only in secure storage. */
export function createHostsStore(storage: SecureStorage, now = () => Date.now()) {
  // A late native write must finish before a later Forget removes its token.
  let pending: Promise<unknown> = Promise.resolve();
  function ordered<T>(work: () => Promise<T>): Promise<T> {
    const next = pending.then(work);
    pending = next.catch(() => {});
    return next;
  }
  async function read(): Promise<SavedHost[]> {
    const value = await storage.getItemAsync(hostsKey);
    if (value === null) {
      // Before multiple computers, one connection was stored on its own.
      const legacy = await storage.getItemAsync(legacyKey);
      if (legacy === null) return [];
      try {
        return [validate({ ...JSON.parse(legacy), lastUsed: 0 })];
      } catch {
        return [];
      }
    }
    let entries: unknown[];
    try {
      entries = JSON.parse(value);
    } catch {
      entries = [];
    }
    // A damaged entry is dropped instead of locking every saved computer, and pairing, behind it.
    return sorted(
      (Array.isArray(entries) ? entries : []).flatMap((entry) => {
        try {
          return [validate(entry)];
        } catch {
          return [];
        }
      }),
    );
  }
  async function write(hosts: SavedHost[]) {
    await storage.setItemAsync(hostsKey, JSON.stringify(sorted(hosts).slice(0, MAX_HOSTS)));
    await storage.deleteItemAsync(legacyKey);
  }
  return {
    list: () => ordered(read),
    save: (host: { name: string; address: string; token: string; access?: Access; relay?: RelayLink }) =>
      ordered(async () => {
        const hosts = await read();
        const saved = validate({ ...host, lastUsed: now() });
        const known = hosts.find((item) => item.id === saved.id);
        // Pairing again keeps what the phone learned about the computer and whether the list hides it.
        const next = { ...saved, ...(known?.routes ? { routes: known.routes } : {}), ...(known?.hidden ? { hidden: true } : {}) };
        await write([next, ...hosts.filter((item) => item.id !== saved.id)]);
        return next;
      }),
    /** Remembers (or, with undefined, forgets) how to reach this computer on the local network. */
    learn: (id: string, lan: LanRoute | undefined) =>
      ordered(async () => {
        await write(
          (await read()).map((item) => {
            if (item.id !== id) return item;
            const { routes: _old, ...rest } = item;
            return lan ? { ...rest, routes: { lan } } : rest;
          }),
        );
      }),
    rename: (id: string, name: string) =>
      ordered(async () => {
        const trimmed = name.trim();
        if (!trimmed) throw new Error("Give this computer a name.");
        await write((await read()).map((item) => (item.id === id ? { ...item, name: trimmed.slice(0, 80) } : item)));
      }),
    /** Hides a computer's Chats from the sidebar, or shows them again. */
    setHidden: (id: string, hidden: boolean) =>
      ordered(async () => {
        await write(
          (await read()).map((item) => {
            if (item.id !== id) return item;
            const { hidden: _old, ...rest } = item;
            return hidden ? { ...rest, hidden: true } : rest;
          }),
        );
      }),
    forget: (id: string) => ordered(async () => write((await read()).filter((item) => item.id !== id))),
  };
}

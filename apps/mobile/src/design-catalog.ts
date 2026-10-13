import type { ArtifactSummary } from "@milagre/shared/artifact";

type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };
type Entry = { designs: ArtifactSummary[] | null; seen: Set<string>; reading: Promise<void> | null; again: boolean };
const catalogs = new WeakMap<Caller, Map<string, Entry>>();
const listeners = new Set<() => void>();
const entryFor = (client: Caller, chatId: string) => {
  let chats = catalogs.get(client);
  if (!chats) {
    chats = new Map();
    catalogs.set(client, chats);
  }
  let entry = chats.get(chatId);
  if (!entry) {
    entry = { designs: null, seen: new Set(), reading: null, again: false };
    chats.set(chatId, entry);
  }
  return entry;
};

export const designCatalog = (client: Caller | null, chatId?: string): ArtifactSummary[] | null => (client && chatId ? entryFor(client, chatId).designs : null);

export function subscribeDesignCatalog(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Share one lookup across a Chat's reply cards. A newly completed version refreshes its metadata once. */
export function readDesignCatalog(client: Caller, chatId: string, revision: string): Promise<void> {
  const entry = entryFor(client, chatId);
  if (entry.seen.has(revision)) return entry.reading ?? Promise.resolve();
  entry.seen.add(revision);
  if (entry.reading) {
    entry.again = true;
    return entry.reading;
  }
  entry.reading = (async () => {
    do {
      entry.again = false;
      try {
        const list = await client.call<ArtifactSummary[]>("artifact:list", [{ chatId }]);
        entry.designs = Array.isArray(list) ? list.filter((design) => design.format === "design") : [];
      } catch {
        entry.designs = [];
        entry.seen.clear();
      }
      for (const listener of listeners) listener();
    } while (entry.again);
  })().finally(() => {
    entry.reading = null;
  });
  return entry.reading;
}

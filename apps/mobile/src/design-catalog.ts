import type { Artifact, ArtifactSummary } from "@milagre/shared/artifact";

type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };
type Entry = {
  designs: ArtifactSummary[] | null;
  seen: Set<string>;
  reading: Promise<void> | null;
  again: boolean;
  unknownIds: Set<string>;
  shownIds: Set<string>;
  deleted: Set<string>;
  htmlAliases: Map<string, ArtifactSummary>;
  enabled: boolean | null;
};
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
    entry = {
      designs: null,
      seen: new Set(),
      reading: null,
      again: false,
      unknownIds: new Set(),
      shownIds: new Set(),
      deleted: new Set(),
      htmlAliases: new Map(),
      enabled: null,
    };
    chats.set(chatId, entry);
  }
  return entry;
};

export const designCatalog = (client: Caller | null, chatId?: string): ArtifactSummary[] | null => (client && chatId ? entryFor(client, chatId).designs : null);

export const designDeleted = (client: Caller | null, chatId: string | undefined, id: string) =>
  !!client && !!chatId && entryFor(client, chatId).deleted.has(id);

export function markDesignDeleted(client: Caller, chatId: string, id: string) {
  const entry = entryFor(client, chatId);
  entry.deleted.add(id);
  entry.designs = entry.designs?.filter((design) => design.id !== id) ?? null;
  for (const listener of listeners) listener();
}

export function subscribeDesignCatalog(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readDesignCatalog(
  client: Caller,
  chatId: string,
  revision: string,
  unknownIds: string[] = [],
  enabled = true,
  shownIds: string[] = [],
): Promise<void> {
  const entry = entryFor(client, chatId);
  if (entry.enabled !== enabled) {
    entry.enabled = enabled;
    entry.seen.clear();
  }
  if (entry.seen.has(revision)) return entry.reading ?? Promise.resolve();
  entry.seen.add(revision);
  for (const id of unknownIds) entry.unknownIds.add(id);
  if (enabled) for (const id of shownIds) entry.shownIds.add(id);
  if (entry.reading) {
    entry.again = true;
    return entry.reading;
  }
  entry.reading = (async () => {
    do {
      entry.again = false;
      const shown = [...entry.shownIds];
      entry.shownIds.clear();
      try {
        const list = await client.call<ArtifactSummary[]>("artifact:list", [{ chatId }]);
        const visible = Array.isArray(list) ? list.filter((design) => design.format === "design" || design.format === "html") : [];
        if (Array.isArray(list) && entry.enabled) for (const id of shown) if (!visible.some((item) => item.id === id)) entry.deleted.add(id);
        for (const id of Array.from(entry.unknownIds)) {
          entry.unknownIds.delete(id);
          if (visible.some((item) => item.id === id) || entry.htmlAliases.has(id)) continue;
          try {
            const artifact = await client.call<Artifact>("artifact:get", [{ chatId, id }]);
            if (artifact.format === "html") {
              const { title, version, versions, width, height } = artifact;
              entry.htmlAliases.set(id, { id, format: "html", title, version, versions, width, height });
            }
          } catch {}
        }
        entry.designs = [...visible, ...[...entry.htmlAliases.values()].filter((alias) => !visible.some((item) => item.id === alias.id))];
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

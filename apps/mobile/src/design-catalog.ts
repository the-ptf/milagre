import type { Artifact, ArtifactSummary } from "@milagre/shared/artifact";

type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };
type Entry = {
  designs: ArtifactSummary[] | null;
  seen: Set<string>;
  reading: Promise<void> | null;
  again: boolean;
  unknownIds: Set<string>;
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
    entry = { designs: null, seen: new Set(), reading: null, again: false, unknownIds: new Set(), htmlAliases: new Map(), enabled: null };
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
export function readDesignCatalog(client: Caller, chatId: string, revision: string, unknownIds: string[] = [], enabled = true): Promise<void> {
  const entry = entryFor(client, chatId);
  if (entry.enabled !== enabled) {
    entry.enabled = enabled;
    entry.seen.clear();
  }
  if (entry.seen.has(revision)) return entry.reading ?? Promise.resolve();
  entry.seen.add(revision);
  for (const id of unknownIds) entry.unknownIds.add(id);
  if (entry.reading) {
    entry.again = true;
    return entry.reading;
  }
  entry.reading = (async () => {
    do {
      entry.again = false;
      try {
        const list = await client.call<ArtifactSummary[]>("artifact:list", [{ chatId }]);
        const visible = Array.isArray(list) ? list.filter((design) => design.format === "design" || design.format === "html") : [];
        for (const id of [...entry.unknownIds]) {
          entry.unknownIds.delete(id);
          if (visible.some((item) => item.id === id) || entry.htmlAliases.has(id)) continue;
          try {
            const artifact = await client.call<Artifact>("artifact:get", [{ chatId, id }]);
            if (artifact.format === "html") {
              const { title, version, versions, width, height } = artifact;
              entry.htmlAliases.set(id, { id, format: "html", title, version, versions, width, height });
            }
          } catch {
            // A missing structured design may simply be disabled. Never guess that it is HTML.
          }
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

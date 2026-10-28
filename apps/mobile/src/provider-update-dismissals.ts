type Storage = { getItemAsync: (key: string) => Promise<string | null>; setItemAsync: (key: string, value: string) => Promise<void> };
const KEY = "milagre.provider-update-dismissals.v1";
// Enough for every provider on a handful of computers; the oldest dismissals drop first.
const MAX_ENTRIES = 40;

/** A computer's id (a URL) as a short hash, so the saved value stays small and holds no address. */
function hostHash(hostId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < hostId.length; i++) hash = Math.imul(hash ^ hostId.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16);
}

function parse(raw: string | null): string[] {
  try {
    const value = JSON.parse(raw || "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The provider releases (`provider:version`) dismissed on this phone, per paired computer. A dismissed release
 * stays hidden across reconnects and relaunches; a newer release of the same provider shows again.
 */
export function createProviderUpdateDismissals(storage: Storage) {
  // Serialize writes so a slow save cannot put an older list back.
  let pending = Promise.resolve();
  const read = () => storage.getItemAsync(KEY).then(parse, () => []);
  return {
    async load(hostId: string): Promise<string[]> {
      await pending;
      const prefix = `${hostHash(hostId)} `;
      return (await read()).filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
    },
    add(hostId: string, key: string): Promise<void> {
      const entry = `${hostHash(hostId)} ${key}`;
      const save = async () => {
        const entries = (await read()).filter((existing) => existing !== entry);
        await storage.setItemAsync(KEY, JSON.stringify([...entries, entry].slice(-MAX_ENTRIES)));
      };
      pending = pending.then(save).catch(() => {});
      return pending;
    },
  };
}

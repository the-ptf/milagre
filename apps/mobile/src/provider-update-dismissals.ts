type Storage = { getItemAsync: (key: string) => Promise<string | null>; setItemAsync: (key: string, value: string) => Promise<void> };
const KEY = "milagre.provider-update-dismissals.v1";
const MAX_ENTRIES = 40;

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

export function createProviderUpdateDismissals(storage: Storage) {
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

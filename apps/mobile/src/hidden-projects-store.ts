type Storage = { getItemAsync: (key: string) => Promise<string | null>; setItemAsync: (key: string, value: string) => Promise<void> };
const keyPrefix = "milagre.hidden-projects.v1.";
// As project-order-store: some iOS releases refused SecureStore values above about 2048 bytes.
const MAX_BYTES = 1900;
const NONE: ReadonlySet<string> = new Set();

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

export function boundedHidden(hostId: string, paths: string[]): string[] {
  const kept: string[] = [];
  let bytes = utf8Length(JSON.stringify({ h: hostId, p: [] }));
  for (const path of paths.toReversed()) {
    bytes += utf8Length(JSON.stringify(path)) + 1;
    if (bytes > MAX_BYTES) break;
    kept.unshift(path);
  }
  return kept;
}

export function applyHiddenProjects<T extends { path: string; hidden?: boolean }>(hidden: ReadonlySet<string>, projects: T[]): T[] {
  return projects.map((project) => {
    const { hidden: _hidden, ...rest } = project;
    return (hidden.has(project.path) ? { ...rest, hidden: true } : rest) as T;
  });
}

function parse(raw: string | null, hostId: string): string[] {
  try {
    const value = JSON.parse(raw || "null");
    if (!value || value.h !== hostId || !Array.isArray(value.p)) return [];
    return value.p.filter((path: unknown): path is string => typeof path === "string");
  } catch {
    return [];
  }
}

export function createHiddenProjectsStore(storage: Storage) {
  const hidden = new Map<string, ReadonlySet<string>>();
  const loading = new Map<string, Promise<ReadonlySet<string>>>();
  let pending = Promise.resolve();
  const save = (hostId: string, paths: ReadonlySet<string>) => {
    pending = pending
      .then(async () => {
        const value = JSON.stringify({ h: hostId, p: boundedHidden(hostId, [...paths]) });
        if (value === (await storage.getItemAsync(keyFor(hostId)))) return;
        await storage.setItemAsync(keyFor(hostId), value);
      })
      .catch(() => {});
    return pending;
  };
  const load = (hostId: string): Promise<ReadonlySet<string>> => {
    const existing = hidden.get(hostId);
    if (existing) return Promise.resolve(existing);
    let work = loading.get(hostId);
    if (!work) {
      work = pending
        .then(() => storage.getItemAsync(keyFor(hostId)))
        .catch(() => null)
        .then((raw) => {
          const current = hidden.get(hostId);
          if (current) return current;
          const loaded = new Set(parse(raw, hostId));
          hidden.set(hostId, loaded);
          return loaded;
        });
      loading.set(hostId, work);
    }
    return work;
  };
  return {
    hidden: (hostId: string): ReadonlySet<string> => hidden.get(hostId) ?? NONE,
    load,
    async apply<T extends { path: string; hidden?: boolean }>(hostId: string, projects: T[]): Promise<T[]> {
      return applyHiddenProjects(await load(hostId), projects);
    },
    setHidden(hostId: string, path: string, hide: boolean) {
      const next = new Set(hidden.get(hostId) ?? NONE);
      if (hide) next.add(path);
      else next.delete(path);
      hidden.set(hostId, next);
      return save(hostId, next);
    },
  };
}

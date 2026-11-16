import { keepOrder } from "@milagre/shared/stable-order";

type Storage = { getItemAsync: (key: string) => Promise<string | null>; setItemAsync: (key: string, value: string) => Promise<void> };
const keyPrefix = "milagre.project-order.v1.";
// expo-secure-store sets no limit of its own, but the docs note that some iOS releases refused values above about
const MAX_BYTES = 1900;

export function applyProjectOrder<T extends { path: string }>(saved: string[], projects: T[]): T[] {
  return keepOrder(
    saved.map((path) => ({ path })),
    projects,
    (item) => item.path,
  ) as T[];
}

export function moveProject(order: string[], path: string, beforePath: string | null): string[] {
  if (!order.includes(path) || path === beforePath) return order;
  const without = order.filter((item) => item !== path);
  const at = beforePath === null ? without.length : without.indexOf(beforePath);
  if (at === -1) return order;
  return [...without.slice(0, at), path, ...without.slice(at)];
}

export function dropBefore(bands: { path: string; top: number; bottom: number }[], y: number): string | null {
  const sorted = bands.filter((band) => band.bottom > band.top).sort((a, b) => a.top - b.top);
  const over = sorted.find((band) => y >= band.top && y <= band.bottom);
  if (over) return y < (over.top + over.bottom) / 2 ? over.path : (sorted[sorted.indexOf(over) + 1]?.path ?? null);
  return sorted.find((band) => band.top > y)?.path ?? null;
}

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

export function boundedOrder(hostId: string, order: string[]): string[] {
  const kept: string[] = [];
  let bytes = utf8Length(JSON.stringify({ h: hostId, o: [] }));
  for (const path of order) {
    bytes += utf8Length(JSON.stringify(path)) + 1;
    if (bytes > MAX_BYTES) break;
    kept.push(path);
  }
  return kept;
}

function parse(raw: string | null, hostId: string): string[] | null {
  try {
    const value = JSON.parse(raw || "null");
    if (!value || value.h !== hostId || !Array.isArray(value.o)) return null;
    return value.o.filter((path: unknown): path is string => typeof path === "string");
  } catch {
    return null;
  }
}

export function createProjectOrderStore(storage: Storage) {
  let pending = Promise.resolve();
  return {
    async apply<T extends { path: string }>(hostId: string, projects: T[]): Promise<T[]> {
      try {
        await pending;
        const saved = parse(await storage.getItemAsync(keyFor(hostId)), hostId);
        return saved ? applyProjectOrder(saved, projects) : projects;
      } catch {
        return projects;
      }
    },
    save(hostId: string, order: string[]) {
      pending = pending
        .then(async () => {
          const value = JSON.stringify({ h: hostId, o: boundedOrder(hostId, order) });
          if (value === (await storage.getItemAsync(keyFor(hostId)))) return;
          await storage.setItemAsync(keyFor(hostId), value);
        })
        .catch(() => {});
      return pending;
    },
  };
}

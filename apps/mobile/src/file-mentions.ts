import { promptParts } from "@milagre/shared/prompt-parts";

/** `@query` at the caret: the start of the token and what was typed after the `@`. */
export function fileQueryAt(draft: string, caret: number) {
  const match = /(^|\s)@([^\s@"]*)$/.exec(draft.slice(0, caret));
  return match ? { start: match.index + (match[1]?.length ?? 0), end: caret, query: match[2] ?? "" } : null;
}

export const isOldMacError = (message: string) => /not available from mobile/i.test(message);

export function mentionPaths(draft: string) {
  const paths: string[] = [];
  for (const part of promptParts(draft, { skills: [], files: (path) => !/[.,!?;:)\]}]$/.test(path) }))
    if (part.kind === "file" && !paths.includes(part.path)) paths.push(part.path);
  return paths;
}

export const exactMatch = (results: readonly string[], path: string) => results.includes(path);

type Caller = { call<T>(method: string, args: unknown[]): Promise<T> };

export function createKnownFiles() {
  const roots = new Map<string, { known: Set<string>; checked: Set<string> }>();
  const of = (root: string) => {
    let entry = roots.get(root);
    if (!entry) roots.set(root, (entry = { known: new Set(), checked: new Set() }));
    return entry;
  };
  const pending = new Map<string, Promise<void>>();
  function lookup(client: Caller, root: string, path: string): Promise<void> {
    const entry = of(root);
    if (entry.checked.has(path)) return Promise.resolve();
    const key = `${root}\n${path}`;
    const shared = pending.get(key);
    if (shared) return shared;
    const asked = client
      .call<string[]>("project:files", [root, path])
      .then((results) => {
        entry.checked.add(path);
        if (exactMatch(results, path)) entry.known.add(path);
      })
      .catch((error: Error) => {
        if (isOldMacError(error?.message ?? "")) entry.checked.add(path);
      })
      .finally(() => pending.delete(key));
    pending.set(key, asked);
    return asked;
  }
  return {
    has: (root: string, path: string) => of(root).known.has(path),
    seed(root: string, path: string) {
      of(root).known.add(path);
      of(root).checked.add(path);
    },
    unchecked: (root: string, paths: readonly string[], max = 3) => paths.filter((path) => !of(root).checked.has(path)).slice(0, max),
    lookup,
    async resolve(client: Caller, root: string, paths: readonly string[], timeoutMs = 1000) {
      const todo = paths.filter((path) => !of(root).checked.has(path));
      if (!todo.length) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(todo.map((path) => lookup(client, root, path))), new Promise<void>((done) => (timer = setTimeout(done, timeoutMs)))]);
      clearTimeout(timer);
    },
  };
}
export type KnownFiles = ReturnType<typeof createKnownFiles>;

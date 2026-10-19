import { promptParts } from "@milagre/shared/prompt-parts";

/** `@query` at the caret: the start of the token and what was typed after the `@`. */
export function fileQueryAt(draft: string, caret: number) {
  const match = /(^|\s)@([^\s@"]*)$/.exec(draft.slice(0, caret));
  return match ? { start: match.index + (match[1]?.length ?? 0), end: caret, query: match[2] ?? "" } : null;
}

/** A Mac that predates the phone's `project:files` answers 403 "Command is not available from mobile". */
export const isOldMacError = (message: string) => /not available from mobile/i.test(message);

/** Every `@path` a draft writes, once each, in order, without the punctuation that ends a sentence. */
export function mentionPaths(draft: string) {
  const paths: string[] = [];
  for (const part of promptParts(draft, { skills: [], files: (path) => !/[.,!?;:)\]}]$/.test(path) }))
    if (part.kind === "file" && !paths.includes(part.path)) paths.push(part.path);
  return paths;
}

/** A search answers a typed path only when one of its results is exactly that path. */
export const exactMatch = (results: readonly string[], path: string) => results.includes(path);

/** Which typed `@path`s name a file in the Project, per root, as far as the Mac has answered this session. */
export function createKnownFiles() {
  const roots = new Map<string, { known: Set<string>; checked: Set<string> }>();
  const of = (root: string) => {
    let entry = roots.get(root);
    if (!entry) roots.set(root, (entry = { known: new Set(), checked: new Set() }));
    return entry;
  };
  const asked = new Set<string>();
  return {
    has: (root: string, path: string) => of(root).known.has(path),
    /** A file picked from the menu is known without asking. */
    seed(root: string, path: string) {
      of(root).known.add(path);
      of(root).checked.add(path);
    },
    /** Up to `max` paths neither answered nor being asked about; they count as asked until `record`ed or `release`d. */
    claim(root: string, paths: readonly string[], max = 3) {
      const entry = of(root);
      const take = paths.filter((path) => !entry.checked.has(path) && !asked.has(`${root}\n${path}`)).slice(0, max);
      for (const path of take) asked.add(`${root}\n${path}`);
      return take;
    },
    record(root: string, path: string, found: boolean) {
      asked.delete(`${root}\n${path}`);
      of(root).checked.add(path);
      if (found) of(root).known.add(path);
    },
    /** The question failed without an answer (a busy Mac): ask again next time. */
    release(root: string, path: string) {
      asked.delete(`${root}\n${path}`);
    },
  };
}
export type KnownFiles = ReturnType<typeof createKnownFiles>;

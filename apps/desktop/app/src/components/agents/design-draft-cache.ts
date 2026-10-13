import type { DesignArtifact as Artifact } from "@milagre/shared/artifact";
import type { DesignDocument } from "@milagre/shared/design";

export type DesignHistory = { past: DesignDocument[]; present: DesignDocument; future: DesignDocument[] };
export type DesignFieldDraft = { value: string; base: string };
export type DesignDraft = {
  saved: Artifact;
  history: DesignHistory;
  selection: string[];
  fields: [string, DesignFieldDraft][];
  recovery?: { saved: Artifact; history: DesignHistory } | null;
};
const measure = (value: unknown) => JSON.stringify(value).length * 2;

// Renderer-session recovery only. Bound retained strings and trim oldest undo entries before evicting drafts.
export function createDesignDraftCache(maxBytes = 16 * 1024 * 1024, maxEntries = 5) {
  const entries = new Map<string, { draft: DesignDraft; bytes: number }>();
  return {
    read(key: string) {
      return entries.get(key)?.draft;
    },
    delete(key: string) {
      entries.delete(key);
    },
    save(key: string, value: DesignDraft) {
      const draft = {
        ...value,
        saved: { ...value.saved, html: "" },
        history: { ...value.history, past: [...value.history.past], future: [...value.history.future] },
        recovery: value.recovery
          ? {
              saved: { ...value.recovery.saved, html: "" },
              history: { ...value.recovery.history, past: [...value.recovery.history.past], future: [...value.recovery.history.future] },
            }
          : null,
      };
      const sizes = new Map<DesignDocument, number>();
      const documentBytes = (document: DesignDocument) => {
        let bytes = sizes.get(document);
        if (bytes === undefined) {
          bytes = measure(document) + 2;
          sizes.set(document, bytes);
        }
        return bytes;
      };
      const histories = [draft.history, ...(draft.recovery ? [draft.recovery.history] : [])];
      const queues = histories.map((history) => ({ history, past: history.past.map(documentBytes), future: history.future.map(documentBytes) }));
      let bytes =
        measure({
          ...draft,
          history: { ...draft.history, past: [], future: [] },
          recovery: draft.recovery ? { ...draft.recovery, history: { ...draft.recovery.history, past: [], future: [] } } : null,
        }) + queues.reduce((total, queue) => total + [...queue.past, ...queue.future].reduce((sum, size) => sum + size, 0), 0);
      for (const queue of queues) {
        while (bytes > maxBytes && (queue.history.past.length || queue.history.future.length)) {
          if (queue.history.past.length) {
            queue.history.past.shift();
            bytes -= queue.past.shift()!;
          } else {
            queue.history.future.pop();
            bytes -= queue.future.pop()!;
          }
        }
      }
      entries.delete(key);
      if (bytes > maxBytes) return;
      while (entries.size && (entries.size >= maxEntries || [...entries.values()].reduce((total, entry) => total + entry.bytes, bytes) > maxBytes))
        entries.delete(entries.keys().next().value!);
      entries.set(key, { draft, bytes });
    },
  };
}

export const designDraftCache = createDesignDraftCache();

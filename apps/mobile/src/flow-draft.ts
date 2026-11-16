import { useCallback, useSyncExternalStore } from "react";
import type { FlowStep, Routine } from "@milagre/shared/model";

type Save = (id: string, patch: Record<string, unknown>) => Promise<void>;
type Entry = {
  steps: FlowStep[];
  version: number;
  saved: number;
  timer: ReturnType<typeof setTimeout> | null;
  writing: Promise<void> | null;
  again: boolean;
  error: string;
  save: Save;
};

const SAVE_AFTER = 700;

const drafts = new WeakMap<object, Map<string, Entry>>();
const listeners = new Set<() => void>();
let tick = 0;
const emit = () => {
  tick++;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => tick;

function mapFor(client: object) {
  let map = drafts.get(client);
  if (!map) {
    map = new Map();
    drafts.set(client, map);
  }
  return map;
}

function write(map: Map<string, Entry>, id: string, entry: Entry): Promise<void> {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.writing) {
    entry.again = true;
    return entry.writing;
  }
  if (entry.saved === entry.version && !entry.error) return Promise.resolve();
  entry.writing = (async () => {
    try {
      do {
        entry.again = false;
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
        const version = entry.version;
        try {
          await entry.save(id, { flowDraft: entry.steps });
          entry.saved = version;
          entry.error = "";
        } catch (failure) {
          entry.error = failure instanceof Error ? failure.message : "Could not save the draft.";
          break;
        }
      } while (entry.again || entry.saved < entry.version);
    } finally {
      entry.writing = null;
      if (!entry.error && entry.saved === entry.version && map.get(id) === entry) map.delete(id);
      emit();
    }
  })();
  return entry.writing;
}

export function useFlowDraft(client: object | null, routine: (Pick<Routine, "id" | "flow"> & Partial<Routine>) | undefined, save: Save) {
  useSyncExternalStore(subscribe, snapshot);
  const map = client ? mapFor(client) : null;
  const id = routine?.id ?? "";
  const entry = map && id ? map.get(id) : undefined;
  const flow = routine?.flow;
  const steps = entry?.steps ?? flow?.draft?.steps ?? flow?.steps ?? [];

  const edit = useCallback(
    (next: FlowStep[]) => {
      if (!map || !id) return;
      let current = map.get(id);
      if (!current) {
        current = { steps: next, version: 0, saved: 0, timer: null, writing: null, again: false, error: "", save };
        map.set(id, current);
      }
      const target = current;
      target.steps = next;
      target.version++;
      target.save = save;
      if (target.timer) clearTimeout(target.timer);
      target.timer = setTimeout(() => void write(map, id, target), SAVE_AFTER);
      emit();
    },
    [map, id, save],
  );
  const flush = useCallback(async () => {
    const current = map && id ? map.get(id) : undefined;
    if (!map || !current) return;
    await write(map, id, current);
    if (current.error) throw new Error(current.error);
  }, [map, id]);
  const discard = useCallback(async () => {
    const current = map && id ? map.get(id) : undefined;
    if (current?.timer) clearTimeout(current.timer);
    if (current?.writing) await current.writing.catch(() => {});
    map?.delete(id);
    emit();
    await save(id, { flowDraft: null });
  }, [map, id, save]);

  return {
    steps,
    published: flow?.steps ?? [],
    hasDraft: Boolean(entry || flow?.draft),
    pending: Boolean(entry),
    error: entry?.error ?? "",
    edit,
    flush,
    discard,
  };
}

export type FlowDraft = ReturnType<typeof useFlowDraft>;

import { useCallback, useSyncExternalStore } from "react";
import type { FlowStep, Routine } from "@milagre/shared/model";

/** Writes a patch to a Routine (the Routines store's `update`, which reads the list again once the Mac has it). */
type Save = (id: string, patch: Record<string, unknown>) => Promise<void>;
/**
 * A draft being edited on this phone: the steps as they are now, ahead of the Mac's copy until the write lands. `version`
 * counts edits and `saved` the one the Mac has, so a write that answers late never clears a newer edit.
 */
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

/** How long typing rests before the draft is written. */
const SAVE_AFTER = 700;

// One map per client, as the Routines store: a late answer from a computer the phone left never lands on this one's drafts.
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

/** Writes the entry's steps now; edits made while it writes are written once more after it. */
function write(map: Map<string, Entry>, id: string, entry: Entry): Promise<void> {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.writing) {
    entry.again = true;
    return entry.writing;
  }
  // A timer that fires after the entry was written and dropped has nothing left to write.
  if (entry.saved === entry.version && !entry.error) return Promise.resolve();
  entry.writing = (async () => {
    try {
      do {
        entry.again = false;
        // Edits made meanwhile ride on this loop rather than a timer of their own.
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
      // Written and read back: the Mac's draft is this one now, so the screens read it from the Routine again.
      if (!entry.error && entry.saved === entry.version && map.get(id) === entry) map.delete(id);
      emit();
    }
  })();
  return entry.writing;
}

/**
 * A flow's draft as this phone edits it, shared by the Steps tab, the step editor and the Publish sheet. It starts from the
 * Mac's draft (or the published steps when there is none); each edit shows at once and is written after typing rests.
 */
export function useFlowDraft(client: object | null, routine: (Pick<Routine, "id" | "flow"> & Partial<Routine>) | undefined, save: Save) {
  useSyncExternalStore(subscribe, snapshot);
  const map = client ? mapFor(client) : null;
  const id = routine?.id ?? "";
  const entry = map && id ? map.get(id) : undefined;
  const flow = routine?.flow;
  const steps = entry?.steps ?? flow?.draft?.steps ?? flow?.steps ?? [];

  /** Replaces the draft's steps; the write follows once edits rest. */
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
  /** Writes any edit still waiting; throws when the Mac refused it. */
  const flush = useCallback(async () => {
    const current = map && id ? map.get(id) : undefined;
    if (!map || !current) return;
    await write(map, id, current);
    if (current.error) throw new Error(current.error);
  }, [map, id]);
  /** Drops the draft on the Mac and here: the published steps show again. */
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
    /** Whether there is a draft at all: on the Mac, or edits here not written yet. */
    hasDraft: Boolean(entry || flow?.draft),
    /** Edits not yet on the Mac. */
    pending: Boolean(entry),
    error: entry?.error ?? "",
    edit,
    flush,
    discard,
  };
}

export type FlowDraft = ReturnType<typeof useFlowDraft>;

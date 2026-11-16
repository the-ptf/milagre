import type { BabysitSettings } from "@milagre/shared/babysit";

type Patch = Partial<BabysitSettings>;
export type BabysitChange = Patch | ((current: BabysitSettings) => Patch);
export type BabysitState = { settings: BabysitSettings | null; error: string; unsupported: boolean };
export type BabysitHost = { read(): Promise<BabysitSettings | null>; save(patch: Patch): Promise<BabysitSettings> };

export function babysitHost(client: { call<T>(method: string, args: unknown[]): Promise<T> }): BabysitHost {
  return {
    read: () => client.call<BabysitSettings | null>("babysit:settings:read", []),
    save: (patch) => client.call<BabysitSettings>("babysit:settings:save", [patch]),
  };
}

export function babysitSettingsStore(onState: (state: BabysitState) => void) {
  let confirmed: BabysitSettings | null = null;
  let unconfirmed: { patch: Patch }[] = [];
  let answers = 0;
  let state: BabysitState = { settings: null, error: "", unsupported: false };

  const show = (error = state.error, unsupported = state.unsupported) => {
    const settings: BabysitSettings | null = confirmed ? Object.assign({}, confirmed, ...unconfirmed.map((entry) => entry.patch)) : null;
    state = { settings, error, unsupported };
    onState(state);
  };

  return {
    snapshot: () => state,
    async read(mac: BabysitHost) {
      const sent = answers;
      try {
        const value = await mac.read();
        if (sent !== answers) return;
        confirmed = value;
        show("", value === null);
      } catch {
        show("Could not read the Babysit PRs settings.");
      }
    },
    async save(mac: BabysitHost, change: BabysitChange) {
      const current = state.settings;
      if (!current) return;
      const patch = typeof change === "function" ? change(current) : change;
      const entry = { patch };
      unconfirmed = [...unconfirmed, entry];
      show("");
      try {
        const saved = await mac.save(patch);
        answers += 1;
        unconfirmed = unconfirmed.filter((item) => item !== entry);
        confirmed = saved;
        show();
      } catch (cause) {
        unconfirmed = unconfirmed.filter((item) => item !== entry);
        show(cause instanceof Error ? cause.message : "Could not change this setting.");
        throw cause;
      }
    },
  };
}

export type SaveState = "idle" | "saving" | "saved" | "error";

export function createDebouncedSave(save: (patch: Patch) => Promise<void>, ms = 500, onState?: (state: SaveState) => void) {
  let pending: Patch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;
  let generation = 0;
  let state: SaveState = "idle";
  const set = (next: SaveState) => {
    state = next;
    onState?.(next);
  };
  const flush = async () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const patch = pending;
    pending = null;
    if (!patch) return;
    const sent = generation;
    inFlight += 1;
    set("saving");
    try {
      await save(patch);
      if (sent !== generation) return;
      inFlight -= 1;
      if (!inFlight && !pending) set("saved");
    } catch {
      if (sent !== generation) return;
      inFlight -= 1;
      set("error");
    }
  };
  return {
    edit(patch: Patch) {
      pending = { ...pending, ...patch };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void flush(), ms);
    },
    flush,
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
      inFlight = 0;
      generation += 1;
    },
    get state() {
      return state;
    },
  };
}

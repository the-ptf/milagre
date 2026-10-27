import type { BabysitSettings } from "@milagre/shared/babysit";

// Settings › Experimental › Babysit PRs on the phone: the same saves as desktop's lib/babysit-settings.ts, reaching the
// connected Mac's daemon through the client instead of the preload bridge.

type Patch = Partial<BabysitSettings>;
/** A change, or a function that builds it from the latest settings shown (changes still on their way included). */
export type BabysitChange = Patch | ((current: BabysitSettings) => Patch);
/** `unsupported`: the Mac answered null, it is too old to have Babysit PRs. */
export type BabysitState = { settings: BabysitSettings | null; error: string; unsupported: boolean };
/** The connected Mac's two commands: `babysit:settings:read` (null on an older Mac) and `babysit:settings:save`. */
export type BabysitHost = { read(): Promise<BabysitSettings | null>; save(patch: Patch): Promise<BabysitSettings> };

/** The connected Mac's client as a BabysitHost. */
export function babysitHost(client: { call<T>(method: string, args: unknown[]): Promise<T> }): BabysitHost {
  return {
    read: () => client.call<BabysitSettings | null>("babysit:settings:read", []),
    save: (patch) => client.call<BabysitSettings>("babysit:settings:save", [patch]),
  };
}

/**
 * The Mac's Babysit PRs settings for one screen. Changes show at once; each answer from the Mac is shown with the
 * changes still on their way laid over it, so an earlier answer never undoes a later change, and a failed change goes
 * back on its own. Each call names the Mac it goes to, so a reconnect uses the new client.
 */
export function babysitSettingsStore(onState: (state: BabysitState) => void) {
  let confirmed: BabysitSettings | null = null;
  let unconfirmed: { patch: Patch }[] = [];
  // Counts the Mac's answers to saves: a read sent before one of them may hold older values, so it is dropped.
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
    /** Rejects when the Mac refuses it, after the change has gone back and `error` says why. */
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

/**
 * A typed field's save: one call 500 ms after typing stops, or at once on flush (blur, leaving the screen). `cancel` (Reset)
 * drops what was typed and not yet sent; a save already on its way still lands but no longer marks the field.
 */
export function createDebouncedSave(save: (patch: Patch) => Promise<void>, ms = 500, onState?: (state: SaveState) => void) {
  let pending: Patch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;
  // Bumped by cancel: answers to saves sent before it are not this field's any more.
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
      // Saved only once nothing newer is typed or still on its way; each save carries the whole text, so the last to land wins.
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

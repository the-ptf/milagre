import type { OrchestratorMemoryNote, OrchestratorSettings, OrchestratorSnapshot, OrchestratorTask } from "@milagre/shared/orchestrator";
import type { LiveOptions, LiveSignal } from "./live.ts";

export type OrchestratorState = {
  snapshot: OrchestratorSnapshot | null;
  error: string;
  unavailable: boolean;
  loading: boolean;
};
export type OrchestratorClient = {
  call: <T>(method: string, args: unknown[]) => Promise<T>;
  live: (path: string, options: Pick<LiveOptions, "onSignal" | "onStatus">) => { close(): void };
};
export type AppStateLike = { subscribe: (listener: (active: boolean) => void) => () => void };
export type SettingsPatch = Partial<OrchestratorSettings>;

const EMPTY: OrchestratorState = { snapshot: null, error: "", unavailable: false, loading: true };
const refused = (failure: unknown) => /not available from mobile|unknown (command|method)|no handler/i.test((failure as Error)?.message ?? "");
const message = (failure: unknown, fallback: string) => (failure instanceof Error && failure.message ? failure.message : fallback);

function withPatches(snapshot: OrchestratorSnapshot, patches: readonly SettingsPatch[], sent: readonly OrchestratorTask[], gone: ReadonlySet<string>) {
  if (!patches.length && !sent.length && !gone.size) return snapshot;
  const known = new Set(snapshot.tasks.map((task) => task.id));
  return {
    ...snapshot,
    settings: Object.assign({}, snapshot.settings, ...patches),
    tasks: [...snapshot.tasks, ...sent.filter((task) => !known.has(task.id))].filter((task) => !gone.has(task.id)),
  };
}

export function createOrchestratorStore(client: OrchestratorClient, appState: AppStateLike) {
  let state = EMPTY;
  let confirmed: OrchestratorSnapshot | null = null;
  let patches: { patch: SettingsPatch }[] = [];
  let sent: OrchestratorTask[] = [];
  const gone = new Set<string>();
  let shown = state;
  const listeners = new Set<() => void>();
  let refs = 0;
  let live: { close(): void } | null = null;
  let unwatch: (() => void) | null = null;
  let reading: Promise<void> | null = null;
  let again = false;
  let writes = 0;

  const emit = (next: Partial<OrchestratorState> = {}) => {
    state = { ...state, ...next };
    shown = confirmed
      ? {
          ...state,
          snapshot: withPatches(
            confirmed,
            patches.map((entry) => entry.patch),
            sent,
            gone,
          ),
        }
      : state;
    for (const listener of listeners) listener();
  };

  function openLive() {
    if (live || refs === 0 || !confirmed?.settings.enabled) return;
    let down = false;
    live = client.live("", {
      onSignal: (signal: LiveSignal) => {
        if (signal === "orchestrator") void refresh();
      },
      onStatus: (up) => {
        if (up && down) void refresh();
        down = !up;
      },
    });
  }
  function closeLive() {
    live?.close();
    live = null;
  }

  async function read() {
    const write = writes;
    try {
      const value = await client.call<OrchestratorSnapshot | null>("orchestrator:read", []);
      if (write !== writes) {
        again = true;
        return;
      }
      if (!value || typeof value !== "object" || !value.settings) {
        confirmed = null;
        emit({ snapshot: null, unavailable: true, loading: false, error: "" });
        return;
      }
      confirmed = value;
      sent = sent.filter((task) => !value.tasks.some((known) => known.id === task.id));
      emit({ unavailable: false, loading: false, error: "" });
      if (value.settings.enabled) openLive();
      else closeLive();
    } catch (failure) {
      if (refused(failure)) {
        confirmed = null;
        emit({ snapshot: null, unavailable: true, loading: false, error: "" });
        return;
      }
      emit({ loading: false, error: message(failure, "Could not read the Orchestrator.") });
    }
  }

  function refresh(): Promise<void> {
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      try {
        do {
          again = false;
          await read();
        } while (again);
      } finally {
        reading = null;
      }
    })();
    return reading;
  }

  async function run<T>(method: string, args: unknown[]): Promise<T> {
    writes++;
    try {
      return await client.call<T>(method, args);
    } finally {
      void refresh();
    }
  }

  return {
    get: () => shown,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acquire() {
      refs++;
      if (refs === 1) {
        unwatch = appState.subscribe((active) => {
          if (active) void refresh();
        });
        openLive();
      }
      return () => {
        refs--;
        if (refs > 0) return;
        closeLive();
        unwatch?.();
        unwatch = null;
      };
    },
    refresh,
    async saveSettings(patch: SettingsPatch) {
      const entry = { patch };
      patches = [...patches, entry];
      emit({ error: "" });
      try {
        const saved = await run<OrchestratorSettings>("orchestrator:settings:save", [patch]);
        if (confirmed && saved) confirmed = { ...confirmed, settings: saved };
        patches = patches.filter((item) => item !== entry);
        emit();
        if (confirmed?.settings.enabled) openLive();
      } catch (failure) {
        patches = patches.filter((item) => item !== entry);
        emit({ error: message(failure, "Could not change this setting.") });
        throw failure;
      }
    },
    async send(prompt: string, options: { permissionMode?: "ask" | "auto" | "full"; images?: { id: string; name: string; dataUrl: string }[] } = {}) {
      const task = await run<OrchestratorTask>("orchestrator:send", [prompt, options]);
      if (task?.id && !confirmed?.tasks.some((known) => known.id === task.id)) {
        sent = [...sent, task];
        emit();
      }
      return task;
    },
    async act(method: string, args: unknown[], { optimisticDrop }: { optimisticDrop?: string } = {}) {
      if (optimisticDrop) {
        gone.add(optimisticDrop);
        emit();
      }
      try {
        return await run<unknown>(method, args);
      } finally {
        if (optimisticDrop) {
          gone.delete(optimisticDrop);
          emit();
        }
      }
    },
    async saveNotes(notes: OrchestratorMemoryNote[]) {
      if (confirmed) {
        confirmed = { ...confirmed, memory: { ...confirmed.memory, notes } };
        emit();
      }
      await run("orchestrator:memory:save", [notes]);
    },
  };
}

export type OrchestratorStore = ReturnType<typeof createOrchestratorStore>;

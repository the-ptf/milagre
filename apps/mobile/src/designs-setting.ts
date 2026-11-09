/** Whether the connected computer has Designs: always, unless it runs an older Milagre with Designs off. Keep its last answer visible while reconnecting. */
export type DesignsState = { enabled: boolean | null; stale: boolean; error: string };
type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };
export const DESIGNS_DISCONNECTED: DesignsState = { enabled: null, stale: true, error: "" };

const confirmed = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || typeof (value as { enabled?: unknown }).enabled !== "boolean")
    throw new Error("Update Milagre on your Mac to use Designs.");
  return (value as { enabled: boolean }).enabled;
};

export function createDesignsSetting(client: Caller) {
  let state: DesignsState = DESIGNS_DISCONNECTED;
  let generation = 0;
  let reading: Promise<void> | null = null;
  let readAgain = false;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (next: DesignsState) => {
    if (disposed) return;
    if (state.enabled === next.enabled && state.stale === next.stale && state.error === next.error) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const unavailable = (message: string) => {
    generation++;
    publish({ ...state, stale: true, error: message });
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (reading) {
      readAgain = true;
      return reading ?? Promise.resolve();
    }
    reading = (async () => {
      do {
        readAgain = false;
        const current = ++generation;
        publish({ ...state, stale: true, error: "" });
        try {
          const enabled = confirmed(await client.call("designs:enabled:read", []));
          if (current === generation) publish({ enabled, stale: false, error: "" });
        } catch (error) {
          if (current === generation) publish({ ...state, stale: true, error: error instanceof Error ? error.message : "Could not read the Designs setting." });
        }
      } while (readAgain);
    })().finally(() => {
      reading = null;
    });
    return reading;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    unavailable,
    resume() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      readAgain = false;
      generation++;
      listeners.clear();
    },
  };
}

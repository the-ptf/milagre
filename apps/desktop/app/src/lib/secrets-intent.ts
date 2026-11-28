import { useEffect, useSyncExternalStore } from "react";

let requested = 0;
let handled = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

/** Asks Settings › Secrets to open its Add secret dialog: at once when it shows, or as soon as it opens. */
export function requestAddSecret() {
  requested++;
  emit();
}

/** Runs `open` once per Add secret request, including one made before the page mounted. */
export function useAddSecretRequest(open: () => void) {
  const waiting = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => requested > handled,
  );
  useEffect(() => {
    if (!waiting) return;
    handled = requested;
    emit();
    open();
  }, [waiting, open]);
}

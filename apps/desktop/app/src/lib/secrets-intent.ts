import { useEffect, useSyncExternalStore } from "react";

function createIntent() {
  let requested = 0;
  let handled = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const request = () => {
    requested++;
    emit();
  };
  const useRequest = (open: () => void) => {
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
  };
  return [request, useRequest] as const;
}

/** Asks Settings › Secrets to open its Add secret dialog: at once when it shows, or as soon as it opens. The hook runs `open` once per request, including one made before the page mounted. */
export const [requestAddSecret, useAddSecretRequest] = createIntent();

/** The same for the Add login dialog. */
export const [requestAddLogin, useAddLoginRequest] = createIntent();

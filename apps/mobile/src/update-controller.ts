export type NativeUpdateState = {
  isStartupProcedureRunning: boolean;
  isChecking: boolean;
  isDownloading: boolean;
  isUpdatePending: boolean;
  checkError?: Error;
  downloadError?: Error;
  downloadedUpdate?: { updateId?: string; manifest?: unknown };
};
export type UpdateState = {
  status: "idle" | "disabled" | "checking" | "up-to-date" | "check-error" | "downloading" | "ready" | "restarting" | "error";
  error: string;
  updateId?: string;
  releaseNotes?: string;
};
type ManifestResult = { manifest?: unknown };
type Dependencies = {
  enabled: boolean;
  check: () => Promise<{ isAvailable: boolean; isRollBackToEmbedded: boolean } & ManifestResult>;
  fetch: () => Promise<{ isNew: boolean; isRollBackToEmbedded: boolean } & ManifestResult>;
  reload: () => Promise<unknown>;
  now?: () => number;
};

function updateDetails(manifest: unknown): Pick<UpdateState, "updateId" | "releaseNotes"> {
  const value = manifest as { id?: unknown; extra?: { expoClient?: { extra?: { releaseNotes?: unknown } } } } | undefined;
  const notes = value?.extra?.expoClient?.extra?.releaseNotes;
  return { updateId: typeof value?.id === "string" ? value.id : undefined, releaseNotes: typeof notes === "string" ? notes : undefined };
}

/** Native startup downloads and foreground checks share one notice. Applying an update always needs a tap. */
export function createUpdateController({ enabled, check, fetch, reload, now = Date.now }: Dependencies) {
  let snapshot: NativeUpdateState = { isStartupProcedureRunning: false, isChecking: false, isDownloading: false, isUpdatePending: false };
  let state: UpdateState = { status: enabled ? "idle" : "disabled", error: "" };
  let inFlight: Promise<void> | null = null;
  let lastCheck = -Infinity;
  const listeners = new Set<() => void>();
  const applying = () => state.status === "restarting";
  function publish(
    status: UpdateState["status"],
    error = "",
    details: Pick<UpdateState, "updateId" | "releaseNotes"> = { updateId: state.updateId, releaseNotes: state.releaseNotes },
  ) {
    if (state.status === status && state.error === error && state.updateId === details.updateId && state.releaseNotes === details.releaseNotes) return;
    state = { status, error, ...details };
    listeners.forEach((listener) => listener());
  }
  function syncNative(next = snapshot) {
    const previous = snapshot;
    snapshot = next;
    if (!enabled || state.status === "restarting") return;
    if (!inFlight && (snapshot.isChecking || snapshot.isStartupProcedureRunning)) lastCheck = now();
    if (inFlight && state.status !== "checking") return; // A stale native pending flag must not interrupt a replacement download.
    if (snapshot.isDownloading) publish("downloading");
    else if (
      snapshot.isUpdatePending &&
      (!previous.isUpdatePending || previous.downloadedUpdate?.updateId !== snapshot.downloadedUpdate?.updateId || state.status === "idle")
    ) {
      const details = updateDetails(snapshot.downloadedUpdate?.manifest);
      publish("ready", state.status === "ready" ? state.error : "", {
        ...details,
        updateId: snapshot.downloadedUpdate?.updateId ?? details.updateId ?? state.updateId,
      });
    } else if (state.status !== "ready" && !inFlight) {
      if (snapshot.downloadError) publish("error", "Could not download the update. Try again.");
      else if (snapshot.isChecking || snapshot.isStartupProcedureRunning) publish("checking");
      else if (state.status === "checking") publish(snapshot.checkError ? "idle" : "up-to-date");
    }
  }
  function refresh(force = false): Promise<void> {
    if (!enabled) return Promise.resolve();
    syncNative();
    if (inFlight) return inFlight;
    if (state.status === "restarting" || snapshot.isStartupProcedureRunning || snapshot.isChecking || snapshot.isDownloading) return Promise.resolve();
    if (!force && now() - lastCheck < 60000) return Promise.resolve();
    lastCheck = now();
    const ready = state.status === "ready";
    if (!ready) publish("checking");
    inFlight = (async () => {
      try {
        const result = await check();
        if (applying()) return;
        if (!result.isAvailable && !result.isRollBackToEmbedded) {
          if (!ready && state.status !== "ready") publish("up-to-date");
          return;
        }
        const details = updateDetails(result.manifest);
        if (ready && details.updateId && details.updateId === state.updateId) return;
        publish("downloading", "", details);
        const downloaded = await fetch();
        if (applying()) return;
        if (downloaded.isNew || downloaded.isRollBackToEmbedded) publish("ready", "", updateDetails(downloaded.manifest));
        else publish("error", "Could not download the update. Try again.");
      } catch {
        // An offline check must not claim there is an update. A failed known download offers a retry.
        if (state.status === "ready" || state.status === "restarting") return;
        if (state.status === "downloading") publish("error", "Could not download the update. Try again.");
        else if (force) publish("check-error", "Could not check for updates. Check your connection and try again.");
        else publish("idle");
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }
  async function install() {
    if (!enabled || state.status !== "ready") return;
    if (inFlight) await inFlight;
    if (state.status !== "ready") return;
    publish("restarting");
    try {
      await reload();
    } catch {
      publish("ready", "Could not apply the update. Try again.");
    }
  }
  return {
    get: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncNative,
    check: refresh,
    install,
  };
}

/** Only foreground use checks for updates; subscriptions and the timer live as long as the app layout. */
export function watchUpdates(
  controller: ReturnType<typeof createUpdateController>,
  environment: {
    active: () => boolean;
    watchActive: (listener: () => void) => () => void;
    schedule: (refresh: () => void, delayMs: number) => () => void;
  },
) {
  let stopped = false;
  const refresh = () => {
    if (!stopped && environment.active()) void controller.check();
  };
  const unsubscribe = environment.watchActive(refresh);
  const unschedule = environment.schedule(refresh, 15 * 60000);
  refresh();
  return () => {
    stopped = true;
    unsubscribe();
    unschedule();
  };
}

/** True when the update prompt was swiped or backed away: the stack is the one it sat on, minus the prompt.
 * A notification or connection reset replaces the stack instead, and leaves the prompt pending. */
export function promptPopped(withPrompt: readonly string[], promptKey: string, now: readonly string[]) {
  const below = withPrompt.filter((key) => key !== promptKey);
  return below.length === withPrompt.length - 1 && below.length === now.length && below.every((key, index) => key === now[index]);
}

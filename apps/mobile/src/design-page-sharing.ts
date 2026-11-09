import type { DesignPageShare } from "@milagre/shared/artifact";

type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Could not update page sharing.");
export type PageSharingState = {
  shares: DesignPageShare[];
  loading: boolean;
  loaded: boolean;
  busy: string | null;
  error: string;
  checking: boolean;
  availability: { available: boolean; reason?: string } | null;
};

/** A Chat page's one public link, or every published page on the host when chatId is absent.
 * Publishing again updates the snapshot behind the same link. */
export function createDesignPageSharing(client: Caller, chatId?: string | null, kind: "designs" | "artifacts" = "designs") {
  const scope = kind === "artifacts" ? { kind } : {};
  let state: PageSharingState = {
    shares: [],
    loading: false,
    loaded: false,
    busy: null,
    error: "",
    checking: !!chatId,
    availability: null,
  };
  let generation = 0;
  let statusGeneration = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const update = (next: PageSharingState) => {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const history = () => client.call<DesignPageShare[]>(chatId ? "artifact:page-shares" : "artifact:all-page-shares", chatId ? [{ chatId, ...scope }] : []);
  const checkAvailability = async () => {
    if (disposed || !chatId) return;
    const current = ++statusGeneration;
    update({ ...state, checking: true });
    try {
      const value = await client.call<{ available: boolean; reason?: string }>("artifact:sharing-status", kind === "artifacts" ? [{ kind }] : []);
      if (current === statusGeneration)
        update({
          ...state,
          checking: false,
          availability:
            value?.available === true
              ? value
              : {
                  available: false,
                  reason: value?.reason || "The sharing service is unavailable.",
                },
        });
    } catch (error) {
      if (current === statusGeneration)
        update({
          ...state,
          checking: false,
          availability: { available: false, reason: errorText(error) },
        });
    }
  };
  return {
    checkAvailability,
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh() {
      if (disposed || state.busy) return;
      const current = ++generation;
      update({ ...state, loading: true, error: "" });
      try {
        const shares = await history();
        if (current === generation) update({ ...state, shares, loading: false, loaded: true });
      } catch (error) {
        if (current === generation) update({ ...state, loading: false, error: errorText(error) });
      }
    },
    /** The host names the page after its Chat; `title` only satisfies an older host, which requires one. */
    async publish(title: string) {
      if (disposed || !chatId || state.busy || !state.loaded || state.checking || !state.availability?.available || !title.trim()) return;
      const current = ++generation;
      update({ ...state, loading: false, busy: "publish", error: "" });
      try {
        const share = await client.call<DesignPageShare>("artifact:share-page", [{ chatId, ...scope, title: title.trim(), acknowledgePublic: true }]);
        if (current === generation)
          update({
            ...state,
            busy: null,
            shares: [share],
          });
      } catch (error) {
        // An upload may have succeeded despite a lost acknowledgement. Read the link before allowing a retry.
        if (disposed || current !== generation) return;
        try {
          const shares = await history();
          if (current === generation) update({ ...state, shares, busy: null, error: errorText(error) });
        } catch {
          if (current === generation)
            update({
              ...state,
              busy: null,
              loaded: false,
              error: errorText(error),
            });
        }
      }
    },
    async revoke(id: string) {
      if (disposed || state.busy) return;
      const current = ++generation;
      update({ ...state, loading: false, busy: id, error: "" });
      try {
        await client.call(chatId ? "artifact:revoke-page-share" : "artifact:revoke-saved-page-share", [chatId ? { chatId, id, ...scope } : { id }]);
        if (current === generation)
          update({
            ...state,
            busy: null,
            // A Chat page drops its revoked link, so the next publish creates a new one. Host history keeps the row.
            shares: chatId ? state.shares.filter((item) => item.id !== id) : state.shares.map((item) => (item.id === id ? { ...item, revoked: true } : item)),
          });
      } catch (error) {
        if (current === generation) update({ ...state, busy: null, error: errorText(error) });
      }
    },
    dispose() {
      disposed = true;
      generation++;
      statusGeneration++;
      listeners.clear();
    },
  };
}

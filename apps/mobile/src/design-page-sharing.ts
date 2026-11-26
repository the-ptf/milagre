import type { ArtifactPageKind, DesignPageShare } from "@milagre/shared/artifact";

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

export type ShareScope = { kind: ArtifactPageKind; designId?: string; designIds?: string[] };

/**
 * One published scope of a Chat's Artifact (`chatId`), or every published page of the computer (no `chatId`). The
 * workspace is every design and the HTML page; a new link follows the agent's saves until paused or stopped.
 */
export function createDesignPageSharing(client: Caller, chatId?: string | null, { kind, designId, designIds }: ShareScope = { kind: "workspace" }) {
  const scope = { kind, ...(designId ? { designId } : {}), ...(designIds?.length ? { designIds } : {}) };
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
      const value = await client.call<{ available: boolean; reason?: string }>("artifact:sharing-status", [{ ...scope, chatId }]);
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
    async refresh({ quiet = false } = {}) {
      if (disposed || state.busy) return;
      const current = ++generation;
      if (!quiet) update({ ...state, loading: true, error: "" });
      try {
        const shares = await history();
        if (current === generation) update({ ...state, shares, loading: false, loaded: true });
      } catch (error) {
        if (current === generation) update({ ...state, loading: false, error: quiet ? state.error : errorText(error) });
      }
    },
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
    async setPaused(id: string, paused: boolean) {
      if (disposed || !chatId || state.busy) return;
      const current = ++generation;
      update({ ...state, loading: false, busy: paused ? "pause" : "resume", error: "" });
      try {
        const share = await client.call<DesignPageShare>("artifact:set-page-share-paused", [{ chatId, id, paused }]);
        if (current === generation)
          update({ ...state, busy: null, shares: state.shares.map((item) => (item.id === id ? { ...item, ...share, id: share?.id ?? id } : item)) });
      } catch (error) {
        if (current === generation) update({ ...state, busy: null, error: errorText(error) });
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

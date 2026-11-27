import { useEffect, useState, useSyncExternalStore } from "react";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { latestReviewSources, type PrReview, type ReviewCounts } from "@milagre/shared/pr-review";
import type { MilagreBridge } from "../electron.d.ts";
import { bridgeFor } from "./computer-bridge";

type SettingsBridge = Pick<MilagreBridge, "readPrReviewSettings" | "savePrReviewSettings" | "onPrReviewSettings">;
type State = { enabled: boolean; ready: boolean; saving: boolean; error: string };

/** This computer's Review agent switch (Settings › Church), read once and shared by every subscriber. */
function reviewAgentStore(bridge: SettingsBridge) {
  let state: State = { enabled: false, ready: false, saving: false, error: "" };
  const listeners = new Set<() => void>();
  let off: (() => void) | null = null;
  const set = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        bridge.readPrReviewSettings().then(
          (value) => set({ enabled: value?.enabled === true, ready: true }),
          () => set({ ready: true, error: "Could not read this setting." }),
        );
        off = bridge.onPrReviewSettings((value) => set({ enabled: value?.enabled === true, ready: true, error: "" }));
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        off?.();
        off = null;
      };
    },
    async save(enabled: boolean) {
      if (state.saving) return;
      set({ saving: true, error: "" });
      try {
        const value = await bridge.savePrReviewSettings({ enabled });
        set({ enabled: value?.enabled === true, saving: false });
      } catch (cause) {
        set({ saving: false, error: cause instanceof Error ? cause.message : "Could not change this setting." });
      }
    },
  };
}

let shared: ReturnType<typeof reviewAgentStore> | null = null;
const store = () => (shared ??= reviewAgentStore(bridgeFor(LOCAL_COMPUTER)));

export function useReviewAgent() {
  const current = store();
  const state = useSyncExternalStore(current.subscribe, current.snapshot);
  return { ...state, save: current.save };
}

export function usePrReviewCounts(computerIds: readonly string[], enabled: boolean) {
  const key = [...new Set([LOCAL_COMPUTER, ...computerIds])].sort().join("\n");
  const [counts, setCounts] = useState(new Map<string, ReviewCounts & { reviewedAt: number; source: string }>());
  useEffect(() => {
    if (!enabled) return;
    const ids = key.split("\n");
    let generation = 0;
    const read = async () => {
      const version = ++generation;
      const entries = await Promise.all(
        ids.map(
          async (id) =>
            [
              id,
              await bridgeFor(id)
                .readPrReviewCounts()
                .catch(() => null),
            ] as const,
        ),
      );
      if (version === generation) setCounts(latestReviewSources(entries));
    };
    void read();
    const offs = ids.map((id) => bridgeFor(id).onPrReviewsChanged(() => void read()));
    return () => {
      generation++;
      offs.forEach((off) => off());
    };
  }, [enabled, key]);
  return enabled ? counts : null;
}

export function usePrReview(url: string, source?: string) {
  const [review, setReview] = useState<{ source: string; review: PrReview | null } | null>(null);
  useEffect(() => {
    if (!source) return;
    const bridge = bridgeFor(source);
    let generation = 0;
    const read = async () => {
      const version = ++generation;
      const result = await bridge.readPrReview(url).catch(() => null);
      if (version === generation) setReview({ source, review: result });
    };
    void read();
    const off = bridge.onPrReviewsChanged((change) => {
      if (change.url === url) void read();
    });
    return () => {
      generation++;
      off();
    };
  }, [url, source]);
  return review?.source === source && review?.review?.url === url ? review.review : null;
}

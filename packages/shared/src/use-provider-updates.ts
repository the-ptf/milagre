import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelProvider, ProviderUpdate } from "./model.ts";
import type { ProviderUpdateItem, ProviderUpdateProgress } from "./provider-update-view.ts";

export type ProviderUpdateResult = { ok: boolean; error?: string; log?: string };
export interface ProviderUpdateTransport {
  read: () => Promise<ProviderUpdate[]>;
  install: (update: ProviderUpdate) => Promise<ProviderUpdateResult>;
  /** Keeps dismissed releases (`provider:version`) past a reconnect or relaunch. */
  dismissals?: { load: () => Promise<string[]>; add: (key: string) => Promise<void> };
  /** Calls back with install progress, or with nothing when the host's list changed and should be read again. */
  watch?: (listener: (progress?: { provider: ModelProvider } & ProviderUpdateProgress) => void) => () => void;
}
type Run = { status: "updating" | "failed"; progress?: ProviderUpdateProgress; error?: string; log?: string };

const ORDER: ModelProvider[] = ["claude", "codex", "antigravity", "kiro"];
const keyOf = (update: ProviderUpdate) => `${update.provider}:${update.version}`;
const FAILED = "The update failed. Try again.";

export function useProviderUpdates(transport: ProviderUpdateTransport | null) {
  const [updates, setUpdates] = useState<ProviderUpdate[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [dismissalsRead, setDismissalsRead] = useState(!transport?.dismissals);
  const [runs, setRuns] = useState<ReadonlyMap<ModelProvider, Run>>(() => new Map());
  const [done, setDone] = useState<ProviderUpdate[]>([]);
  const generation = useRef(0);
  const busy = useRef(new Set<ModelProvider>());
  const revision = useRef(0);
  const latest = useRef<ProviderUpdate[]>([]);
  const [source, setSource] = useState(transport);
  const setRun = (provider: ModelProvider, run: Run | null) =>
    setRuns((previous) => {
      const next = new Map(previous);
      if (run) next.set(provider, run);
      else next.delete(provider);
      return next;
    });
  const refresh = useCallback(async () => {
    if (!transport) return;
    const current = generation.current;
    const request = ++revision.current;
    try {
      const next = await transport.read();
      if (!Array.isArray(next)) return;
      if (generation.current === current && request === revision.current) {
        latest.current = next;
        setUpdates(next);
      }
    } catch {
      /* An older or offline computer simply has no update notice. */
    }
  }, [transport]);
  useEffect(() => {
    generation.current++;
    setSource(transport);
    setUpdates([]);
    latest.current = [];
    setDismissed(new Set());
    setDismissalsRead(!transport?.dismissals);
    setRuns(new Map());
    setDone([]);
    busy.current.clear();
    const active = generation.current;
    const dismissals = transport?.dismissals;
    if (dismissals)
      void (async () => {
        const keys = await dismissals.load().catch(() => []);
        if (generation.current !== active) return;
        setDismissed((previous) => new Set([...previous, ...keys]));
        setDismissalsRead(true);
      })();
    void refresh();
    const timer = setInterval(() => {
      if (!busy.current.size) void refresh();
    }, 30 * 60_000);
    const unwatch = transport?.watch?.((progress) => {
      if (generation.current !== active) return;
      if (!progress) return void refresh();
      const { provider, ...rest } = progress;
      setRuns((previous) => {
        const run = previous.get(provider);
        if (run?.status !== "updating") return previous;
        return new Map(previous).set(provider, { ...run, progress: rest as ProviderUpdateProgress });
      });
    });
    return () => {
      generation.current++;
      clearInterval(timer);
      unwatch?.();
    };
  }, [transport, refresh]);

  const shown = source === transport && dismissalsRead;
  const items = useMemo<ProviderUpdateItem[]>(() => {
    if (!shown) return [];
    const finished = done.map((update) => ({ ...update, status: "done" as const }));
    const open = updates
      .filter((update) => !dismissed.has(keyOf(update)) && !done.some((item) => item.provider === update.provider))
      .map((update): ProviderUpdateItem => {
        const run = runs.get(update.provider);
        if (run) return { ...update, ...run, progress: run.progress ?? update.progress };
        return { ...update, status: update.progress ? "updating" : "available" };
      });
    return [...finished, ...open].sort((a, b) => ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));
  }, [shown, updates, dismissed, runs, done]);

  const install = async (provider: ModelProvider) => {
    const update = latest.current.find((item) => item.provider === provider);
    if (!update || !transport || busy.current.has(provider)) return false;
    const active = generation.current;
    busy.current.add(provider);
    revision.current++;
    setRun(provider, { status: "updating", progress: update.progress });
    try {
      const result = await transport.install(update);
      if (active !== generation.current) return false;
      if (result.ok) {
        setDone((previous) => [...previous.filter((item) => item.provider !== provider), update]);
        setRun(provider, null);
        return true;
      }
      setRun(provider, { status: "failed", error: result.error || FAILED, log: result.log });
      return false;
    } catch (reason) {
      if (active === generation.current) setRun(provider, { status: "failed", error: reason instanceof Error ? reason.message : FAILED });
      return false;
    } finally {
      busy.current.delete(provider);
      if (active === generation.current) void refresh();
    }
  };
  const installAll = async () => {
    for (const item of items) if (item.status === "available" || item.status === "failed") await install(item.provider);
  };
  /** Hides every update shown now until a newer release; one that is installing keeps going. */
  const dismiss = () => {
    const keys = items.filter((item) => item.status === "available" || item.status === "failed").map(keyOf);
    setDismissed((previous) => new Set([...previous, ...keys]));
    for (const key of keys) void transport?.dismissals?.add(key).catch(() => {});
    setDone([]);
    setRuns((previous) => new Map([...previous].filter(([, run]) => run.status === "updating")));
  };
  const clearDone = useCallback(() => setDone([]), []);
  return { items, install, installAll, dismiss, clearDone, refresh };
}

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { PullRequestDetail, PullRequestDetailResult, PullRequestWriteResult, ReviewGuideResult } from "@milagre/shared/pull-request-review";
import type { Client } from "./client";

// One PR's detail and review guide, shared by every page of the PR sheet and the iPad panel, so going from the overview
// to a file and back reads GitHub once. Reads refresh every 30 s while something shows them and after every write.

type Entry = { pr: PullRequestDetail | null; error: string; loading: boolean };
type GuideEntry = { result: ReviewGuideResult | null };

const details = new Map<string, Entry>();
const guides = new Map<string, GuideEntry>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<void>>();
const EMPTY: Entry = { pr: null, error: "", loading: true };
const NO_GUIDE: GuideEntry = { result: null };

export const prKey = (cwd: string, number: number) => `${cwd}#${number}`;

function emit(key: string) {
  for (const listener of listeners.get(key) ?? []) listener();
}

function subscribe(key: string, listener: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

function setEntry(key: string, entry: Entry) {
  details.set(key, entry);
  emit(key);
}

/** Reads the PR again; calls arriving together share one read. Never throws. */
export function loadDetail(client: Client, cwd: string, number: number) {
  const key = prKey(cwd, number);
  const running = inflight.get(key);
  if (running) return running;
  const task = (async () => {
    const current = details.get(key) ?? EMPTY;
    if (!current.pr) setEntry(key, { ...current, loading: true });
    try {
      const result = await client.call<PullRequestDetailResult>("pr:detail", [{ cwd, number }]);
      if (result.ok) setEntry(key, { pr: result.pr, error: "", loading: false });
      else setEntry(key, { pr: current.pr, error: result.message, loading: false });
    } catch (error) {
      setEntry(key, { pr: (details.get(key) ?? current).pr, error: error instanceof Error ? error.message : String(error), loading: false });
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/** Shows a write at once; the read after the write confirms it or puts GitHub's answer back. */
export function patchDetail(cwd: string, number: number, change: (pr: PullRequestDetail) => PullRequestDetail) {
  const key = prKey(cwd, number);
  const current = details.get(key);
  if (current?.pr) setEntry(key, { ...current, pr: change(current.pr) });
}

/**
 * A review write through the Mac (`pr:comment`, `pr:merge`, …), with an optional optimistic change. The PR is read again
 * whatever happens, so a failed write shows GitHub's state again. Never throws: `ok: false` carries the reason.
 */
export async function writePr(
  client: Client,
  cwd: string,
  number: number,
  method: string,
  request: Record<string, unknown>,
  optimistic?: (pr: PullRequestDetail) => PullRequestDetail,
): Promise<PullRequestWriteResult> {
  if (optimistic) patchDetail(cwd, number, optimistic);
  let result: PullRequestWriteResult;
  try {
    result = await client.call<PullRequestWriteResult>(method, [{ cwd, number, ...request }]);
  } catch (error) {
    result = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  await loadDetail(client, cwd, number);
  return result;
}

/** The PR, read when shown and every 30 s while shown and the app is in front. */
export function usePrDetail(client: Client | null, cwd: string | undefined, number: number, active = true) {
  const key = cwd ? prKey(cwd, number) : "";
  const entry = useSyncExternalStore(
    useCallback((listener) => (key ? subscribe(key, listener) : () => {}), [key]),
    () => (key ? (details.get(key) ?? EMPTY) : EMPTY),
  );
  useEffect(() => {
    if (!client || !cwd || !active || !Number.isSafeInteger(number)) return;
    const refresh = () => {
      if (AppState.currentState === "active") void loadDetail(client, cwd, number);
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    const subscription = AppState.addEventListener("change", refresh);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [client, cwd, number, active]);
  const refresh = useCallback(() => {
    if (client && cwd) void loadDetail(client, cwd, number);
  }, [client, cwd, number]);
  return { ...entry, refresh };
}

async function loadGuide(client: Client, cwd: string, url: string) {
  try {
    const result = await client.call<ReviewGuideResult>("pr:guide", [{ cwd, url }]);
    guides.set(url, { result });
  } catch (error) {
    guides.set(url, { result: { ok: false, message: error instanceof Error ? error.message : String(error) } });
  }
  emit(`guide:${url}`);
}

/** The PR's review guide: read when shown, every 3 s while one is being written. */
export function usePrGuide(client: Client | null, cwd: string | undefined, url: string | undefined, active = true) {
  const key = url ? `guide:${url}` : "";
  const entry = useSyncExternalStore(
    useCallback((listener) => (key ? subscribe(key, listener) : () => {}), [key]),
    () => (url ? (guides.get(url) ?? NO_GUIDE) : NO_GUIDE),
  );
  const writing = entry.result?.ok === true && entry.result.writing;
  useEffect(() => {
    if (!client || !cwd || !url || !active) return;
    void loadGuide(client, cwd, url);
    if (!writing) return;
    const timer = setInterval(() => void loadGuide(client, cwd, url), 3000);
    return () => clearInterval(timer);
  }, [client, cwd, url, active, writing]);
  const write = useCallback(
    async (number: number, provider?: string) => {
      if (!client || !cwd || !url) return;
      const started = await client
        .call<{ ok: true; writing: true } | { ok: false; message: string }>("pr:write-guide", [{ cwd, number, url, provider }])
        .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }));
      const current = guides.get(url)?.result;
      guides.set(url, {
        result: started.ok
          ? { ok: true, guide: current?.ok ? current.guide : null, read: current?.ok ? current.read : [], writing: true }
          : { ok: false, message: started.message },
      });
      emit(key);
    },
    [client, cwd, url, key],
  );
  const markRead = useCallback(
    (stop: number) => {
      if (!client || !cwd || !url) return;
      const current = guides.get(url)?.result;
      if (current?.ok && !current.read.includes(stop)) {
        guides.set(url, { result: { ...current, read: [...current.read, stop] } });
        emit(key);
      }
      void client.call("pr:guide-read", [{ cwd, url, stop, read: true }]).catch(() => {});
    },
    [client, cwd, url, key],
  );
  return { result: entry.result, write, markRead };
}

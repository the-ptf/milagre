import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { PullRequestDetail, PullRequestDetailResult, PullRequestWriteResult } from "@milagre/shared/pull-request-review";
import type { Client } from "./client";

// One PR's detail, shared by every page of the PR sheet and the iPad panel, so going from the overview

type Entry = { pr: PullRequestDetail | null; error: string; loading: boolean };

const details = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<void>>();
const generations = new Map<string, number>();
const readAt = new Map<string, number>();
const POLL_MS = 30000;
const EMPTY: Entry = { pr: null, error: "", loading: true };

const prKey = (cwd: string, number: number) => `${cwd}#${number}`;

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

const bump = (key: string) => generations.set(key, (generations.get(key) ?? 0) + 1);

function loadDetail(client: Client, cwd: string, number: number, fresh = false) {
  const key = prKey(cwd, number);
  const running = inflight.get(key);
  if (running && !fresh) return running;
  const generation = generations.get(key) ?? 0;
  const task = (async () => {
    const current = details.get(key) ?? EMPTY;
    if (!current.pr) setEntry(key, { ...current, loading: true });
    let next: Entry;
    try {
      const result = await client.call<PullRequestDetailResult>("pr:detail", [{ cwd, number }]);
      next = result.ok ? { pr: result.pr, error: "", loading: false } : { pr: (details.get(key) ?? current).pr, error: result.message, loading: false };
    } catch (error) {
      next = { pr: (details.get(key) ?? current).pr, error: error instanceof Error ? error.message : String(error), loading: false };
    }
    if (!next.error) readAt.set(key, Date.now());
    if ((generations.get(key) ?? 0) !== generation) return;
    const shown = details.get(key);
    if (shown && !shown.loading && shown.error === next.error && JSON.stringify(shown.pr) === JSON.stringify(next.pr)) return;
    setEntry(key, next);
  })();
  inflight.set(key, task);
  void task.finally(() => {
    if (inflight.get(key) === task) inflight.delete(key);
  });
  return task;
}

export function patchDetail(cwd: string, number: number, change: (pr: PullRequestDetail) => PullRequestDetail) {
  const key = prKey(cwd, number);
  const current = details.get(key);
  if (current?.pr) setEntry(key, { ...current, pr: change(current.pr) });
}

export async function writePr(
  client: Client,
  cwd: string,
  number: number,
  method: string,
  request: Record<string, unknown>,
  optimistic?: (pr: PullRequestDetail) => PullRequestDetail,
): Promise<PullRequestWriteResult> {
  const key = prKey(cwd, number);
  bump(key);
  const before = details.get(key)?.pr;
  if (optimistic) patchDetail(cwd, number, optimistic);
  const patched = details.get(key)?.pr;
  let result: PullRequestWriteResult;
  try {
    result = await client.call<PullRequestWriteResult>(method, [{ cwd, number, ...request }]);
  } catch (error) {
    result = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const current = details.get(key);
  if (!result.ok && optimistic && before && current && current.pr === patched) setEntry(key, { ...current, pr: before });
  bump(key);
  await loadDetail(client, cwd, number, true);
  return result;
}

export function usePrDetail(client: Client | null, cwd: string | undefined, number: number, active = true) {
  const key = cwd ? prKey(cwd, number) : "";
  const entry = useSyncExternalStore(
    useCallback((listener) => (key ? subscribe(key, listener) : () => {}), [key]),
    () => (key ? (details.get(key) ?? EMPTY) : EMPTY),
  );
  useEffect(() => {
    if (!client || !cwd || !active || !Number.isSafeInteger(number)) return;
    const refresh = () => {
      if (AppState.currentState !== "active") return;
      if (Date.now() - (readAt.get(prKey(cwd, number)) ?? 0) < POLL_MS - 5000) return;
      void loadDetail(client, cwd, number);
    };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
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

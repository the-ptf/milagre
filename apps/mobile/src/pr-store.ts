import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { PullRequestDetail, PullRequestDetailResult, PullRequestWriteResult } from "@milagre/shared/pull-request-review";
import type { Client } from "./client";

// One PR's detail, shared by every page of the PR sheet and the iPad panel, so going from the overview
// to a file and back reads GitHub once. Reads refresh every 30 s while something shows them and after every write.

type Entry = { pr: PullRequestDetail | null; error: string; loading: boolean };

const details = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<void>>();
// Bumped as a write starts and ends: a read begun before then may show the PR from before the write, so its answer is dropped.
const generations = new Map<string, number>();
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

/** Reads the PR again; calls arriving together share one read unless `fresh`. Never throws. */
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
    if ((generations.get(key) ?? 0) === generation) setEntry(key, next);
  })();
  inflight.set(key, task);
  // A fresh read may have taken the slot meanwhile.
  void task.finally(() => {
    if (inflight.get(key) === task) inflight.delete(key);
  });
  return task;
}

/** Shows a write at once; the read after the write confirms it or puts GitHub's answer back. */
export function patchDetail(cwd: string, number: number, change: (pr: PullRequestDetail) => PullRequestDetail) {
  const key = prKey(cwd, number);
  const current = details.get(key);
  if (current?.pr) setEntry(key, { ...current, pr: change(current.pr) });
}

/**
 * A review write through the Mac (`pr:comment`, `pr:merge`, …), with an optional optimistic change, taken back when the
 * write fails. The PR is read again afresh whatever happens, so it shows GitHub's state. Never throws: `ok: false` carries the reason.
 */
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
  // ponytail: only undone while nothing else changed the PR since; otherwise the read below puts GitHub's state back.
  const current = details.get(key);
  if (!result.ok && optimistic && before && current && current.pr === patched) setEntry(key, { ...current, pr: before });
  bump(key);
  await loadDetail(client, cwd, number, true);
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

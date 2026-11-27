import { useSyncExternalStore } from "react";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { ipcErrorMessage } from "@milagre/shared/result";
import {
  PULL_REQUEST_FILTER_CHOICES,
  PULL_REQUEST_FILTER_DEFAULTS,
  PULL_REQUEST_SORTS,
  mergePullRequestLists,
  type PullRequestFilters,
  type PullRequestList,
  type PullRequestListState,
  type PullRequestRow,
  type PullRequestSort,
} from "@milagre/shared/pull-request-list";
import type { ComputersSnapshot, ComputerState } from "../electron.d.ts";
import { bridgeFor } from "./computer-bridge.ts";
import { computersSnapshot, subscribeComputers } from "./computers-store.ts";
import { preferenceStorage as localStorage } from "./preference-storage.ts";

const PULL_REQUESTS_POLL_MS = 60_000;

type ComputerPullRequests = { list: PullRequestList | null; error: string | null; reading: boolean; unsupported: boolean };
export type PullRequestsSnapshot = {
  rows: PullRequestRow[];
  loading: boolean;
  reading: boolean;
  errors: string[];
  state: PullRequestListState;
  byComputer: Readonly<Record<string, ComputerPullRequests>>;
};

const NOT_READ: ComputerPullRequests = { list: null, error: null, reading: false, unsupported: false };
const OLDER_HOST = /not available|unknown (command|method)|no handler/i;
const AWAY: ReadonlySet<ComputerState | "local"> = new Set(["offline", "refused"]);

let byComputer: Record<string, ComputerPullRequests> = {};
let listState: PullRequestListState = "open";
let snapshot: PullRequestsSnapshot = { rows: [], loading: false, reading: false, errors: [], state: listState, byComputer };
const listeners = new Set<() => void>();
const latestRead = new Map<string, number>();
const tracked = new Map<string, ComputerState | "local">();
let stopComputers: (() => void) | undefined;
let poll: ReturnType<typeof setInterval> | undefined;

const firstLine = (text: string) =>
  text
    .split("\n")
    .find((line) => line.trim())
    ?.trim() ?? text.trim();
const order = () => [LOCAL_COMPUTER, ...[...tracked.keys()].filter((id) => id !== LOCAL_COMPUTER)];

function merge(): PullRequestsSnapshot {
  const ids = order().filter((id) => byComputer[id]);
  const reads = ids.map((id) => [id, byComputer[id]!] as const);
  const rows = mergePullRequestLists(
    reads.map(([computerId, entry]) => ({ computerId, list: entry.list, offline: AWAY.has(tracked.get(computerId) ?? "local") })),
  );
  return {
    rows,
    loading: rows.length === 0 && reads.some(([, entry]) => entry.reading && !entry.list),
    reading: reads.some(([, entry]) => entry.reading),
    errors: reads.flatMap(([, entry]) => [...(entry.error ? [entry.error] : []), ...(entry.list?.errors ?? [])]).map(firstLine),
    state: listState,
    byComputer: Object.fromEntries(reads),
  };
}

function publish(computerId: string, next: ComputerPullRequests | null) {
  if (next) byComputer = { ...byComputer, [computerId]: next };
  else {
    const { [computerId]: _gone, ...rest } = byComputer;
    byComputer = rest;
  }
  snapshot = merge();
  for (const listener of listeners) listener();
}

function read(computerId: string, force = false) {
  const id = (latestRead.get(computerId) ?? 0) + 1;
  latestRead.set(computerId, id);
  const current = () => latestRead.get(computerId) === id && tracked.has(computerId);
  publish(computerId, { ...(byComputer[computerId] ?? NOT_READ), reading: true });
  void settle(
    computerId,
    current,
    Promise.resolve().then(() => bridgeFor(computerId).listPullRequests({ state: listState, ...(force ? { force: true } : {}) })),
  );
}

async function settle(computerId: string, current: () => boolean, request: Promise<PullRequestList>) {
  try {
    const list = await request;
    if (current()) publish(computerId, { list, error: null, reading: false, unsupported: false });
  } catch (failure) {
    if (!current()) return;
    const message = ipcErrorMessage(failure);
    if (OLDER_HOST.test(message)) publish(computerId, { ...NOT_READ, unsupported: true });
    else publish(computerId, { ...(byComputer[computerId] ?? NOT_READ), error: message, reading: false });
  }
}

function readable(computerId: string) {
  const state = tracked.get(computerId);
  return state !== undefined && !AWAY.has(state) && byComputer[computerId]?.unsupported !== true;
}

/** Reads every computer again; `force` skips the hosts' one-minute cache. */
export function refreshPullRequests({ force = false }: { force?: boolean } = {}) {
  for (const id of tracked.keys()) if (readable(id)) read(id, force);
}

/** The PR state the hosts read (open, merged, closed or all); the other filters apply here. */
export function setPullRequestListState(next: PullRequestListState) {
  if (next === listState) return;
  listState = next;
  byComputer = Object.fromEntries(Object.entries(byComputer).map(([id, entry]) => [id, { ...entry, list: null }]));
  snapshot = merge();
  for (const listener of listeners) listener();
  for (const id of tracked.keys()) if (readable(id)) read(id);
}

function track(computerId: string, state: ComputerState | "local") {
  const before = tracked.get(computerId);
  tracked.set(computerId, state);
  if (before === undefined) {
    if (!AWAY.has(state)) read(computerId);
    else publish(computerId, byComputer[computerId] ?? NOT_READ);
  } else if (state === "online" && before !== "online") read(computerId);
  else if (AWAY.has(state) !== AWAY.has(before)) publish(computerId, byComputer[computerId] ?? NOT_READ);
}

function untrack(computerId: string) {
  tracked.delete(computerId);
  latestRead.set(computerId, (latestRead.get(computerId) ?? 0) + 1);
  if (byComputer[computerId]) publish(computerId, null);
}

function followComputers(next: ComputersSnapshot | null | undefined) {
  if (!next || !Array.isArray(next.computers)) return;
  const on = new Map(next.computers.filter((computer) => computer.state !== "off").map((computer) => [computer.id, computer.state] as const));
  for (const id of Array.from(tracked.keys())) if (id !== LOCAL_COMPUTER && !on.has(id)) untrack(id);
  for (const [id, state] of on) track(id, state);
}

export const pullRequestsSnapshot = () => snapshot;

/** The first listener starts the reads and the minute's poll; the last one to leave stops both, keeping the data. */
export function subscribePullRequests(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    track(LOCAL_COMPUTER, "local");
    stopComputers = subscribeComputers(() => followComputers(computersSnapshot()));
    followComputers(computersSnapshot());
    poll = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) refreshPullRequests();
    }, PULL_REQUESTS_POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopComputers?.();
    stopComputers = undefined;
    clearInterval(poll);
    poll = undefined;
    for (const id of Array.from(tracked.keys())) {
      tracked.delete(id);
      latestRead.set(id, (latestRead.get(id) ?? 0) + 1);
    }
    byComputer = Object.fromEntries(Object.entries(byComputer).map(([id, entry]) => [id, { ...entry, reading: false }]));
    snapshot = merge();
  };
}

export function usePullRequests(): PullRequestsSnapshot {
  return useSyncExternalStore(subscribePullRequests, pullRequestsSnapshot);
}

export type PullRequestPrefs = { sort: PullRequestSort; filters: PullRequestFilters; computer: string };

const PREFS_KEY = "milagre.pullRequests";
const PULL_REQUEST_PREFS_DEFAULTS: PullRequestPrefs = { sort: "updated", filters: { ...PULL_REQUEST_FILTER_DEFAULTS }, computer: "all" };

function oneOf<T extends string>(value: unknown, choices: readonly { id: T }[], fallback: T): T {
  return choices.some((choice) => choice.id === value) ? (value as T) : fallback;
}
const textOrNull = (value: unknown) => (typeof value === "string" && value ? value : null);

/** The saved sort, filters and computer; anything unknown or missing falls back to its default. */
export function parsePullRequestPrefs(raw: string | null): PullRequestPrefs {
  let saved: Partial<{ sort: unknown; filters: Record<string, unknown>; computer: unknown }> = {};
  try {
    saved = raw ? (JSON.parse(raw) ?? {}) : {};
  } catch {}
  const filters = saved.filters && typeof saved.filters === "object" ? saved.filters : {};
  const defaults = PULL_REQUEST_FILTER_DEFAULTS;
  return {
    sort: oneOf(saved.sort, PULL_REQUEST_SORTS, "updated"),
    computer: typeof saved.computer === "string" && saved.computer ? saved.computer : "all",
    filters: {
      state: oneOf(filters.state, PULL_REQUEST_FILTER_CHOICES.state, defaults.state),
      involvement: oneOf(filters.involvement, PULL_REQUEST_FILTER_CHOICES.involvement, defaults.involvement),
      author: textOrNull(filters.author),
      label: textOrNull(filters.label),
      draft: oneOf(filters.draft, PULL_REQUEST_FILTER_CHOICES.draft, defaults.draft),
      review: oneOf(filters.review, PULL_REQUEST_FILTER_CHOICES.review, defaults.review),
      checks: oneOf(filters.checks, PULL_REQUEST_FILTER_CHOICES.checks, defaults.checks),
      chat: oneOf(filters.chat, PULL_REQUEST_FILTER_CHOICES.chat, defaults.chat),
      project: textOrNull(filters.project),
    },
  };
}

export function readPullRequestPrefs(): PullRequestPrefs {
  try {
    return parsePullRequestPrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return PULL_REQUEST_PREFS_DEFAULTS;
  }
}

export function savePullRequestPrefs(prefs: PullRequestPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

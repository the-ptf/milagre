import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useSyncExternalStore } from "react";
import type { AgentRun, AgentRuns, QueuedRunEvent, RunStatuses } from "./agent-runs.ts";

/**
 * The live runs, outside React state so a tool step re-renders only what shows it.
 *
 * Events apply to `latest`. Readers see `shown`, and live text reads `texts`. While held, both stay put: an event that
 * also changed a Project's state is shown in the same paint as that state, never a frame before it (see useAgentRuns).
 */
export interface AgentRunsStore {
  latest(): AgentRuns;
  shown(): AgentRuns;
  subscribe(listener: () => void): () => void;
  /** `textOnly`: only runs' text changed, which readers of `shown` aren't told about. */
  set(next: AgentRuns, textOnly?: boolean): void;
  hold(): void;
  release(): void;
  text: RunTextStore;
}

export function createAgentRunsStore(): AgentRunsStore {
  let latest: AgentRuns = {};
  let shown = latest;
  let texts = latest;
  let held = false;
  let stale = false;
  const listeners = new Set<() => void>();
  const text = createRunTextStore((key) => texts[key]?.text);
  const flush = () => {
    const before = texts;
    texts = latest;
    if (stale) {
      stale = false;
      shown = latest;
      for (const listener of Array.from(listeners)) listener();
    }
    if (before !== texts) text.notify([...Object.keys(before), ...Object.keys(texts)].filter((key) => before[key]?.text !== texts[key]?.text));
  };
  return {
    latest: () => latest,
    shown: () => shown,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next, textOnly = false) {
      if (next === latest) return;
      latest = next;
      if (!textOnly) stale = true;
      if (!held) flush();
    },
    hold() {
      held = true;
    },
    release() {
      if (!held) return;
      held = false;
      flush();
    },
    text,
  };
}

export const AgentRunsContext = createContext<AgentRunsStore | null>(null);

const NO_RUNS: AgentRuns = {};
const unsubscribed = () => () => {};

/** A slice of the shown runs that keeps its last value while `equal` says it is the same, so readers skip a render. */
function useRunsSelector<T>(store: AgentRunsStore | null, select: (runs: AgentRuns) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const cache = useRef<{ runs: AgentRuns; select: (runs: AgentRuns) => T; value: T } | null>(null);
  const getSnapshot = () => {
    const runs = store?.shown() ?? NO_RUNS;
    const last = cache.current;
    if (last && last.runs === runs && last.select === select) return last.value;
    const next = select(runs);
    const value = last && equal(last.value, next) ? last.value : next;
    cache.current = { runs, select, value };
    return value;
  };
  return useSyncExternalStore(store?.subscribe ?? unsubscribed, getSnapshot);
}

function useAgentRunsStore(): AgentRunsStore | null {
  return useContext(AgentRunsContext);
}

const everyRun = (runs: AgentRuns) => runs;
const noRun = () => NO_RUNS;

/** Every shown run, or none while `enabled` is false, so a closed view isn't rendered for each event. */
export function useRuns(enabled = true): AgentRuns {
  return useRunsSelector(useAgentRunsStore(), enabled ? everyRun : noRun);
}

export function useRunSteps(chatKey: string | undefined): AgentRun["steps"] | undefined {
  return useRunsSelector(
    useAgentRunsStore(),
    useCallback((runs: AgentRuns) => (chatKey ? runs[chatKey]?.steps : undefined), [chatKey]),
  );
}

export type RunShell = Omit<AgentRun, "steps" | "text">;

function shellOf(run: AgentRun | undefined): RunShell | undefined {
  if (!run) return undefined;
  const { steps: _steps, text: _text, ...shell } = run;
  return shell;
}

function sameShell(a: RunShell | undefined, b: RunShell | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof RunShell)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** A Chat's run without its steps and text, which change on every tool step and stream. */
export function useRunShell(store: AgentRunsStore | null, chatKey: string | undefined): RunShell | undefined {
  return useRunsSelector(
    store,
    useCallback((runs: AgentRuns) => shellOf(chatKey ? runs[chatKey] : undefined), [chatKey]),
    sameShell,
  );
}

function statusesOf(runs: AgentRuns): RunStatuses {
  return Object.fromEntries(Object.entries(runs).map(([key, { approvals, questions }]) => [key, { approvals, questions }]));
}

function sameStatuses(a: RunStatuses, b: RunStatuses): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key]?.approvals === b[key]?.approvals && a[key]?.questions === b[key]?.questions);
}

/** Which Chats run and what each waits on: all the sidebar, the canvas and the grid's choice of tiles read. */
export function useRunStatuses(store: AgentRunsStore | null): RunStatuses {
  return useRunsSelector(store, statusesOf, sameStatuses);
}

interface RunTextStore {
  read(chatKey: string): string | undefined;
  subscribe(chatKey: string, listener: () => void): () => void;
  notify(chatKeys: Iterable<string>): void;
}

function createRunTextStore(read: (chatKey: string) => string | undefined): RunTextStore {
  const listeners = new Map<string, Set<() => void>>();
  return {
    read,
    subscribe(chatKey, listener) {
      let set = listeners.get(chatKey);
      if (!set) listeners.set(chatKey, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size && listeners.get(chatKey) === set) listeners.delete(chatKey);
      };
    },
    notify(chatKeys) {
      for (const chatKey of new Set(chatKeys)) for (const listener of Array.from(listeners.get(chatKey) ?? [])) listener();
    },
  };
}

export function onlyTextChanged(previous: AgentRuns, batch: readonly QueuedRunEvent[]): boolean {
  return batch.every(({ chatId, event }) => event.type === "text-delta" && Boolean(previous[chatId]) && !previous[chatId]?.waitingForSubagents);
}

export function useRunText(chatKey: string | undefined): string | undefined {
  const store = useContext(AgentRunsContext)?.text;
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const text = store && chatKey ? store.read(chatKey) : undefined;
  useEffect(() => {
    if (!store || !chatKey) return;
    const unsubscribe = store.subscribe(chatKey, rerender);
    if (store.read(chatKey) !== text) rerender();
    return unsubscribe;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `text` is only compared once, right after subscribing
  }, [store, chatKey]);
  return text;
}

/** A value read from a run's live text; the caller re-renders only when it changes, not on every token. */
export function useRunTextValue<T>(chatKey: string | undefined, read: (text: string | undefined) => T): T {
  const store = useContext(AgentRunsContext)?.text;
  const subscribe = useCallback((notify: () => void) => (store && chatKey ? store.subscribe(chatKey, notify) : () => {}), [store, chatKey]);
  return useSyncExternalStore(subscribe, () => read(store && chatKey ? store.read(chatKey) : undefined));
}

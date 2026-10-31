import type { PullRequest } from "@milagre/shared/model";
import type { Client } from "./client";

type Job = { active: (() => boolean)[]; start: () => Promise<void>; skip: () => void };
type Pool = {
  running: number;
  queue: Job[];
  pending: Map<string, { promise: Promise<PullRequest | null | undefined>; job: Job }>;
  cache: Map<string, { at: number; value: PullRequest | null }>;
};
const pools = new WeakMap<Client, Pool>();
// Keep slow GitHub lookups out of the capacity used by snapshots and sends. A current Mac answers from its own PR poll
// at once; the pool still matters on a Mac that predates it, where each request runs gh. `fresh` skips the 30 s cache:
// the Mac said this Project's PRs changed.
export function readPullRequest(client: Client, path: string, active: () => boolean, ref?: string, fresh = false): Promise<PullRequest | null | undefined> {
  let pool = pools.get(client);
  if (!pool) {
    pool = { running: 0, queue: [], pending: new Map(), cache: new Map() };
    pools.set(client, pool);
  }
  const state = pool;
  const key = JSON.stringify([path, ref]);
  const cached = state.cache.get(key);
  if (cached && ((!fresh && Date.now() - cached.at < 30000) || (ref && cached.value?.state === "MERGED"))) return Promise.resolve(cached.value);
  const pending = state.pending.get(key);
  if (pending) {
    pending.job.active.push(active);
    return pending.promise;
  }
  function drain() {
    while (state.running < 2 && state.queue.length) {
      const job = state.queue.shift()!;
      if (!job.active.some((check) => check())) {
        job.skip();
        continue;
      }
      state.running++;
      void job.start().finally(() => {
        state.running--;
        drain();
      });
    }
  }
  let resolve!: (value: PullRequest | null | undefined) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<PullRequest | null | undefined>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const job: Job = {
    active: [active],
    skip: () => {
      state.pending.delete(key);
      resolve(undefined);
    },
    start: async () => {
      try {
        const value = ref
          ? ((await client.call<(PullRequest | null)[]>("worktree:pull-requests", [path, [ref]]))[0] ?? null)
          : await client.call<PullRequest | null>("worktree:pull-request", [path]);
        // Bound retained status for long sessions across many Projects.
        if (state.cache.size >= 200) state.cache.delete(state.cache.keys().next().value!);
        state.cache.set(key, { at: Date.now(), value });
        resolve(value);
      } catch (error) {
        reject(error);
      } finally {
        state.pending.delete(key);
      }
    },
  };
  state.pending.set(key, { promise, job });
  state.queue.push(job);
  drain();
  return promise;
}

// The open Project's live socket heard "pulls": the Mac's PR poll found a change. Screens showing PRs read again.
const pullListeners = new WeakMap<Client, Set<() => void>>();
export function pullRequestsChanged(client: Client) {
  for (const listener of pullListeners.get(client) ?? []) listener();
}
export function onPullRequestsChanged(client: Client, listener: () => void): () => void {
  let listeners = pullListeners.get(client);
  if (!listeners) pullListeners.set(client, (listeners = new Set()));
  listeners.add(listener);
  return () => listeners.delete(listener);
}

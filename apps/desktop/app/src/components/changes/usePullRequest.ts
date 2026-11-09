import { useCallback, useEffect, useRef, useState } from "react";
import type { PullRequestDetail, PullRequestWriteResult } from "@milagre/shared/pull-request-review";
import type { MilagreBridge } from "../../electron";
import type { PullRequest } from "@milagre/shared/model";
import { pollWhileActive } from "../useWorktreePullRequests";

export type PrState = { status: "idle" | "loading" } | { status: "error"; message: string } | { status: "ready"; pr: PullRequestDetail };

type PrBridge = MilagreBridge["pr"];

/**
 * The PR each Worktree's branch opened (a Link Chat's members, one per Project), read while `active` and every 30 s
 * while the window is focused. A Worktree without one maps to null.
 */
export function useBranchPullRequests({ paths, active, bridge }: { paths: string[]; active: boolean; bridge: MilagreBridge }) {
  const [found, setFound] = useState<Record<string, PullRequest | null>>({});
  const key = paths.join("\n");
  const lastRead = useRef(0);
  useEffect(() => {
    if (!active || !key) return;
    let current = true;
    const read = () => {
      lastRead.current = Date.now();
      const list = key.split("\n");
      void Promise.all(list.map((path) => bridge.readPullRequest(path).catch(() => null))).then((prs) => {
        if (current) setFound(Object.fromEntries(list.map((path, index) => [path, prs[index] ?? null])));
      });
    };
    read();
    const stop = pollWhileActive(read, () => lastRead.current);
    return () => {
      current = false;
      stop();
    };
  }, [active, key, bridge]);
  return found;
}

/** How many uncommitted files the Worktree has (changes its PR doesn't have yet), read while `active`, as the PR is. */
export function useLocalChanges({ cwd, active, bridge }: { cwd: string | undefined; active: boolean; bridge: MilagreBridge }) {
  const [count, setCount] = useState<{ cwd: string; count: number } | null>(null);
  const lastRead = useRef(0);
  const read = useRef<() => Promise<void>>(async () => {});
  read.current = async () => {
    if (!cwd) return;
    lastRead.current = Date.now();
    try {
      const result = await bridge.git.diffFiles({ cwd, mode: "uncommitted" });
      setCount({ cwd, count: result.isRepo ? result.files.length : 0 });
    } catch {}
  };
  useEffect(() => {
    if (!active || !cwd) return;
    void read.current();
    return pollWhileActive(
      () => void read.current(),
      () => lastRead.current,
    );
  }, [active, cwd]);
  const refresh = useCallback(() => void read.current(), []);
  return { count: count && count.cwd === cwd ? count.count : 0, refresh };
}

// The detail of the PR a Chat's branch opened, kept per PR so switching Chats and back shows it at once.
const lastDetail = new Map<string, PullRequestDetail>();
// Each PR as GitHub last answered, and the writes still waiting on it: what shows is that read with them on top.
type Change = (pr: PullRequestDetail) => PullRequestDetail;
const readDetail = new Map<string, PullRequestDetail>();
const pendingWrites = new Map<string, Set<Change>>();
const withPending = (key: string, pr: PullRequestDetail) => [...(pendingWrites.get(key) ?? [])].reduce((next, change) => change(next), pr);

/**
 * The open Chat's PR, read while `active` (the panel shows it, or its diff is open): on opening, every 30 s
 * while the window is focused, and right after each write. A write's failure stays in `writeError` until the next one.
 */
export function usePullRequest({
  cwd,
  number,
  active,
  bridge,
}: {
  cwd: string | undefined;
  number: number | undefined;
  active: boolean;
  bridge: MilagreBridge;
}) {
  const key = cwd && number ? `${cwd}\0${number}` : null;
  const [snapshot, setSnapshot] = useState<{ key: string | null; state: PrState }>(() => ({
    key,
    state: key && lastDetail.has(key) ? { status: "ready", pr: lastDetail.get(key)! } : { status: "idle" },
  }));
  const state: PrState =
    snapshot.key === key ? snapshot.state : key && lastDetail.has(key) ? { status: "ready", pr: lastDetail.get(key)! } : { status: "idle" };
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const request = useRef({ cwd, number, bridge, key });
  request.current = { cwd, number, bridge, key };
  const generation = useRef(0);
  const lastRead = useRef(0);

  const refresh = useCallback(async () => {
    const { cwd, number, bridge, key } = request.current;
    if (!cwd || !number || !key) return;
    const current = ++generation.current;
    lastRead.current = Date.now();
    setSnapshot((previous) =>
      previous.key === key && previous.state.status === "ready"
        ? previous
        : { key, state: lastDetail.has(key) ? { status: "ready", pr: lastDetail.get(key)! } : { status: "loading" } },
    );
    try {
      const result = await bridge.pr.detail({ cwd, number });
      if (current !== generation.current) return;
      if (result.ok) {
        readDetail.set(key, result.pr);
        const pr = withPending(key, result.pr);
        lastDetail.set(key, pr);
        setSnapshot({ key, state: { status: "ready", pr } });
      } else if (!lastDetail.has(key)) setSnapshot({ key, state: { status: "error", message: result.message } });
    } catch (error) {
      if (current === generation.current && !lastDetail.has(key))
        setSnapshot({ key, state: { status: "error", message: error instanceof Error ? error.message : "Couldn't read the PR." } });
    }
  }, []);

  useEffect(() => {
    setWriteError(null);
    if (!active || !key) return;
    void refresh();
    return pollWhileActive(
      () => void refresh(),
      () => lastRead.current,
    );
  }, [active, key, refresh]);

  /** Shows `optimistic` at once, runs the write, and reads the PR again; a failure takes back only its own change. */
  const write = useCallback(
    async (
      label: string,
      run: (pr: PrBridge, cwd: string, number: number) => Promise<PullRequestWriteResult>,
      optimistic?: (pr: PullRequestDetail) => PullRequestDetail,
    ) => {
      const { cwd, number, bridge, key } = request.current;
      if (!cwd || !number || !key) return { ok: false as const, message: "This Chat has no PR." };
      setWriteError(null);
      setBusy(label);
      const show = () => {
        const pr = withPending(key, readDetail.get(key)!);
        lastDetail.set(key, pr);
        if (request.current.key === key) setSnapshot({ key, state: { status: "ready", pr } });
      };
      // Wrapped, so the same change written twice is two entries.
      const entry: Change | undefined = optimistic && readDetail.has(key) ? (pr) => optimistic(pr) : undefined;
      if (entry) {
        pendingWrites.set(key, (pendingWrites.get(key) ?? new Set()).add(entry));
        show();
      }
      let result: PullRequestWriteResult;
      try {
        result = await run(bridge.pr, cwd, number);
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : "GitHub didn't answer." };
      }
      if (entry) {
        pendingWrites.get(key)?.delete(entry);
        // GitHub took it: it stays on the last read until the next one has it. A failure shows the rest without it.
        if (result.ok) readDetail.set(key, entry(readDetail.get(key)!));
        else show();
      }
      if (!result.ok) setWriteError(result.message);
      setBusy(null);
      void refresh();
      return result;
    },
    [refresh],
  );

  return { state, pr: state.status === "ready" ? state.pr : null, refresh, write, writeError, clearError: () => setWriteError(null), busy };
}

export type PullRequestReview = ReturnType<typeof usePullRequest>;

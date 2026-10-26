import { useCallback, useEffect, useRef, useState } from "react";
import type { PullRequestDetail, PullRequestWriteResult, ReviewGuideResult } from "@milagre/shared/pull-request-review";
import type { MilagreBridge } from "../../electron";
import type { ModelProvider } from "../../model";
import { pollWhileActive } from "../useWorktreePullRequests";

export type PrState = { status: "idle" | "loading" } | { status: "error"; message: string } | { status: "ready"; pr: PullRequestDetail };

type PrBridge = MilagreBridge["pr"];

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
const GUIDE_POLL_MS = 3000;

/**
 * The open Chat's PR, read while `active` (the panel shows it, or its diff or guide is open): on opening, every 30 s
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
        lastDetail.set(key, result.pr);
        setSnapshot({ key, state: { status: "ready", pr: result.pr } });
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

  /** Shows `optimistic` at once, runs the write, and reads the PR again; a failure puts the last read back. */
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
      const before = lastDetail.get(key);
      if (optimistic && before) {
        const next = optimistic(before);
        lastDetail.set(key, next);
        setSnapshot({ key, state: { status: "ready", pr: next } });
      }
      let result: PullRequestWriteResult;
      try {
        result = await run(bridge.pr, cwd, number);
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : "GitHub didn't answer." };
      }
      if (!result.ok) {
        setWriteError(result.message);
        if (optimistic && before && request.current.key === key) {
          lastDetail.set(key, before);
          setSnapshot({ key, state: { status: "ready", pr: before } });
        }
      }
      setBusy(null);
      void refresh();
      return result;
    },
    [refresh],
  );

  return { state, pr: state.status === "ready" ? state.pr : null, refresh, write, writeError, clearError: () => setWriteError(null), busy };
}

export type PullRequestReview = ReturnType<typeof usePullRequest>;

/** The PR's review guide: read while `active`, every 3 s while it is being written. */
export function useReviewGuide({ cwd, pr, active, bridge }: { cwd: string | undefined; pr: PullRequestDetail | null; active: boolean; bridge: MilagreBridge }) {
  const url = pr?.url;
  const [snapshot, setSnapshot] = useState<{ url: string | undefined; result: ReviewGuideResult | null }>({ url, result: null });
  const result = snapshot.url === url ? snapshot.result : null;
  const request = useRef({ cwd, url, bridge, number: pr?.number });
  request.current = { cwd, url, bridge, number: pr?.number };

  const read = useCallback(async () => {
    const { cwd, url, bridge } = request.current;
    if (!cwd || !url) return;
    try {
      const next = await bridge.pr.guide({ cwd, url });
      if (request.current.url === url) setSnapshot({ url, result: next });
    } catch (error) {
      if (request.current.url === url)
        setSnapshot({ url, result: { ok: false, message: error instanceof Error ? error.message : "Couldn't read the guide." } });
    }
  }, []);

  useEffect(() => {
    if (active && url) void read();
  }, [active, url, read]);

  const writing = result?.ok === true && result.writing;
  useEffect(() => {
    if (!active || !writing) return;
    const timer = window.setInterval(() => void read(), GUIDE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, writing, read]);

  const write = useCallback(
    async (provider?: ModelProvider) => {
      const { cwd, url, bridge, number } = request.current;
      if (!cwd || !url || !number) return;
      setSnapshot((previous) =>
        previous.url === url && previous.result?.ok ? { url, result: { ...previous.result, writing: true, error: undefined } } : previous,
      );
      try {
        const started = await bridge.pr.writeGuide({ cwd, number, url, provider });
        if (!started.ok) setSnapshot({ url, result: { ok: false, message: started.message } });
      } catch (error) {
        setSnapshot({ url, result: { ok: false, message: error instanceof Error ? error.message : "Couldn't start the guide." } });
      }
      await read();
    },
    [read],
  );

  const markRead = useCallback(async (stop: number, value = true) => {
    const { cwd, url, bridge } = request.current;
    if (!cwd || !url) return;
    setSnapshot((previous) => {
      if (previous.url !== url || !previous.result?.ok) return previous;
      const read = new Set(previous.result.read);
      if (value) read.add(stop);
      else read.delete(stop);
      return { url, result: { ...previous.result, read: [...read].toSorted((a, b) => a - b) } };
    });
    await bridge.pr.guideRead({ cwd, url, stop, read: value }).catch(() => undefined);
  }, []);

  return { result, guide: result?.ok ? result.guide : null, read: result?.ok ? result.read : [], writing, write, markRead, refresh: read };
}

export type ReviewGuideState = ReturnType<typeof useReviewGuide>;

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useFocusEffect } from "expo-router";
import type { PullRequestListState } from "@milagre/shared/pull-request-list";
import { allComputers, useComputerViews } from "./all-computers";
import { createPullRequestsStore, type PullRequestsHost } from "./pull-requests-store";
import { useSession } from "./session";

const store = createPullRequestsStore();
const EVERY = 60 * 1000;

/**
 * Every computer's open (or merged, closed, all) PRs as one list, the connected computer's copy first. Read when the
 * page shows and every minute while it does; `refresh` asks the computers to skip their cache.
 */
export function usePullRequests(state: PullRequestListState) {
  const session = useSession();
  const views = useComputerViews();
  const current = session.client?.url;
  const computers = useMemo(() => {
    const listed = views.map((view) => ({ hostId: view.hostId, name: view.name, online: view.state !== "offline" }));
    const here = listed.find((entry) => entry.hostId === current);
    const others = listed.filter((entry) => entry.hostId !== current);
    return current ? [{ hostId: current, name: here?.name || session.hostName || "Computer", online: true }, ...others] : others;
  }, [views, current, session.hostName]);
  const hosts = useRef<PullRequestsHost[]>([]);
  useEffect(() => {
    hosts.current = computers.map((computer) => ({
      hostId: computer.hostId,
      online: computer.online,
      client: computer.hostId === current ? session.client : allComputers.clientFor(computer.hostId),
    }));
  }, [computers, current, session.client]);
  const ids = computers.map((computer) => computer.hostId).join("\n");
  const read = useCallback((force: boolean) => store.read(hosts.current, state, force), [state]);
  useFocusEffect(
    useCallback(() => {
      if (!ids) return;
      void read(false);
      const timer = setInterval(() => void read(false), EVERY);
      return () => clearInterval(timer);
    }, [read, ids]),
  );
  const version = useSyncExternalStore(store.subscribe, store.version);
  const view = useMemo(
    () => store.view(ids ? ids.split("\n") : [], state),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version changes exactly when an answer lands.
    [version, ids, state],
  );
  const names = useMemo(() => new Map(computers.map((computer) => [computer.hostId, computer.name])), [computers]);
  return { ...view, names, computers: computers.length, refresh: () => read(true) };
}

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useFocusEffect } from "expo-router";
import { AppState } from "react-native";
import type { PullRequest } from "@milagre/shared/model";
import type { Client } from "./client";
import { onPullRequestsChanged, readPullRequest } from "./pr-status";

export type PullRequestTarget = { path: string; refs: string[] };
type Status = Record<string, { branch?: PullRequest; found: Record<string, PullRequest | null> }>;
export type ComputerPullRequestTargets = { hostId: string; client: Client | null; targets: PullRequestTarget[] };
const EMPTY: Status = {};
// The drawer and Chat share the last answer, even after a screen remount or a computer goes offline. Paths alone
// aren't identities: two computers can have the same Worktree path and different PRs.
let statuses: Record<string, Status> = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => statuses;
// A refresh resolves one read per path and ref: the readers re-render once for all of them, not once each.
let notifying = false;
function notify() {
  if (notifying) return;
  notifying = true;
  queueMicrotask(() => {
    notifying = false;
    for (const listener of listeners) listener();
  });
}
const same = (a: PullRequest | null | undefined, b: PullRequest | null | undefined) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Readers rebuild their targets on every list change; the same hosts, clients and paths keep the reads running as they are.
const clientIds = new WeakMap<Client, number>();
let nextClientId = 0;
const clientId = (client: Client | null) => {
  if (!client) return 0;
  let id = clientIds.get(client);
  if (!id) clientIds.set(client, (id = ++nextClientId));
  return id;
};

/** Reads each computer's PRs while the screen is focused and the app active; answers land in the shared store. */
function usePullRequestReads(computers: ComputerPullRequestTargets[]) {
  const key = JSON.stringify(computers.map(({ hostId, client, targets }) => [hostId, clientId(client), targets]));
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` names everything the reads depend on.
  const stable = useMemo(() => computers, [key]);
  useFocusEffect(
    useCallback(() => {
      if (!stable.some(({ client, targets }) => client && targets.length)) return;
      let focused = true;
      const active = () => focused && AppState.currentState === "active";
      const refreshComputer = ({ hostId, client, targets }: ComputerPullRequestTargets, fresh = false) => {
        if (!client || !active()) return;
        for (const { path, refs } of targets) {
          for (const ref of [undefined, ...refs]) {
            void readPullRequest(client, path, active, ref, fresh)
              .then((value) => {
                if (!active() || value === undefined) return;
                const previous = statuses[hostId] ?? EMPTY;
                const old = previous[path] || { found: {} };
                // A cached or unchanged answer leaves the store, and everyone reading it, alone.
                if (ref ? ref in old.found && same(old.found[ref], value) : same(old.branch, value || undefined)) return;
                const next = ref ? { ...old, found: { ...old.found, [ref]: value } } : { ...old, branch: value || undefined };
                statuses = Object.assign({}, statuses, { [hostId]: Object.assign({}, previous, { [path]: next }) });
                notify();
              })
              .catch(() => {});
          }
        }
      };
      const refresh = () => stable.forEach((computer) => refreshComputer(computer));
      refresh();
      const timer = setInterval(refresh, 30000);
      const subscription = AppState.addEventListener("change", refresh);
      const stops = stable.map((computer) => (computer.client ? onPullRequestsChanged(computer.client, () => refreshComputer(computer, true)) : () => {}));
      return () => {
        focused = false;
        clearInterval(timer);
        subscription.remove();
        for (const stop of stops) stop();
      };
    }, [stable]),
  );
}

/** Every visible row reads PRs from its own computer, through that client's bounded request pool. */
export function useComputerChatPullRequests(computers: ComputerPullRequestTargets[]) {
  usePullRequestReads(computers);
  return useSyncExternalStore(subscribe, snapshot);
}

/** The open Chat uses the same computer-scoped answers as its row in the drawer, and re-renders only for its computer's. */
export function useChatPullRequests(client: Client | null, targets: PullRequestTarget[]) {
  const targetsKey = JSON.stringify(targets);
  const computers = useMemo<ComputerPullRequestTargets[]>(
    () => (client ? [{ hostId: client.url, client, targets: JSON.parse(targetsKey) }] : []),
    [client, targetsKey],
  );
  usePullRequestReads(computers);
  const hostId = client?.url;
  const read = useCallback(() => (hostId ? (statuses[hostId] ?? EMPTY) : EMPTY), [hostId]);
  return useSyncExternalStore(subscribe, read);
}

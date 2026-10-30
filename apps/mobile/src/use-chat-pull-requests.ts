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

/** Every visible row reads PRs from its own computer, through that client's bounded request pool. */
export function useComputerChatPullRequests(computers: ComputerPullRequestTargets[]) {
  const status = useSyncExternalStore(subscribe, snapshot);
  useFocusEffect(
    useCallback(() => {
      if (!computers.some(({ client, targets }) => client && targets.length)) return;
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
                const next = ref ? { ...old, found: { ...old.found, [ref]: value } } : { ...old, branch: value || undefined };
                statuses = Object.assign({}, statuses, { [hostId]: Object.assign({}, previous, { [path]: next }) });
                for (const listener of listeners) listener();
              })
              .catch(() => {});
          }
        }
      };
      const refresh = () => computers.forEach((computer) => refreshComputer(computer));
      refresh();
      const timer = setInterval(refresh, 30000);
      const subscription = AppState.addEventListener("change", refresh);
      const stops = computers.map((computer) => (computer.client ? onPullRequestsChanged(computer.client, () => refreshComputer(computer, true)) : () => {}));
      return () => {
        focused = false;
        clearInterval(timer);
        subscription.remove();
        for (const stop of stops) stop();
      };
    }, [computers]),
  );
  return status;
}

/** The open Chat uses the same computer-scoped answers as its row in the drawer. */
export function useChatPullRequests(client: Client | null, targets: PullRequestTarget[]) {
  const targetsKey = JSON.stringify(targets);
  const computers = useMemo<ComputerPullRequestTargets[]>(
    () => (client ? [{ hostId: client.url, client, targets: JSON.parse(targetsKey) }] : []),
    [client, targetsKey],
  );
  const status = useComputerChatPullRequests(computers);
  return client ? (status[client.url] ?? EMPTY) : EMPTY;
}

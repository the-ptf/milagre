import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { AppState } from "react-native";
import type { PullRequest } from "@milagre/shared/model";
import type { Client } from "./client";
import { onPullRequestsChanged, readPullRequest } from "./pr-status";

export type PullRequestTarget = { path: string; refs: string[] };
type Status = Record<string, { branch?: PullRequest; found: Record<string, PullRequest | null> }>;

/**
 * Only expanded/filtered Chat rows request GitHub data, sharing the Chat screen's bounded request pool. The Mac polls
 * GitHub itself and says "pulls" on the open Project's live socket when PRs changed (session.tsx passes it on); the
 * 30 s read stays for a Mac that predates that, and while the socket is down.
 */
export function useChatPullRequests(client: Client | null, targets: PullRequestTarget[]) {
  const [status, setStatus] = useState<Status>({});
  const targetsKey = JSON.stringify(targets);
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      const entries: PullRequestTarget[] = JSON.parse(targetsKey);
      let focused = true;
      const active = () => focused && AppState.currentState === "active";
      const refresh = (fresh = false) => {
        if (!active()) return;
        for (const { path, refs } of entries) {
          for (const ref of [undefined, ...refs]) {
            void readPullRequest(client, path, active, ref, fresh)
              .then((value) => {
                if (!active() || value === undefined) return;
                setStatus((previous) => {
                  const old = previous[path] || { found: {} };
                  return {
                    ...previous,
                    [path]: ref ? { ...old, found: { ...old.found, [ref]: value } } : { ...old, branch: value || undefined },
                  };
                });
              })
              .catch(() => {});
          }
        }
      };
      refresh();
      const timer = setInterval(() => refresh(), 30000);
      const subscription = AppState.addEventListener("change", () => refresh());
      const unsubscribe = onPullRequestsChanged(client, () => refresh(true));
      return () => {
        focused = false;
        clearInterval(timer);
        subscription.remove();
        unsubscribe();
      };
    }, [client, targetsKey]),
  );
  return status;
}

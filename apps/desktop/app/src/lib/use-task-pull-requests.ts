import { useEffect, useState } from "react";
import type { PullRequestSnapshot } from "../model";
import { bridgeForKey } from "./computer-bridge";
import { pollWhileActive } from "../components/useWorktreePullRequests";

const NONE: Record<string, PullRequestSnapshot> = {};

/** The host's pull request snapshot for each Project the Orchestrator's tasks run in, read again when the host says they changed. */
export function useTaskPullRequests(scopes: readonly string[], enabled: boolean): Record<string, PullRequestSnapshot> {
  const [snapshots, setSnapshots] = useState(NONE);
  const key = enabled ? [...scopes].sort().join("\n") : "";
  useEffect(() => {
    if (!key) return;
    const list = key.split("\n");
    let disposed = false;
    let lastRead = 0;
    const read = (scope: string) =>
      bridgeForKey(scope)
        .readPullRequestSnapshot(scope)
        .then((found) => {
          if (!disposed && found) setSnapshots((current) => ({ ...current, [scope]: found }));
        })
        .catch(() => {});
    const readAll = () => {
      lastRead = Date.now();
      for (const scope of list) void read(scope);
    };
    readAll();
    const stopPolling = pollWhileActive(readAll, () => lastRead);
    const unsubscribes = [...new Set(list.map((scope) => bridgeForKey(scope)))].map((bridge) =>
      bridge.onPullRequestsChanged((change) => {
        if (list.includes(change.projectPath)) void read(change.projectPath);
      }),
    );
    return () => {
      disposed = true;
      stopPolling();
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [key]);
  return key ? snapshots : NONE;
}

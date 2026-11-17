import { useEffect, useMemo, useState } from "react";
import { chatPullRequests } from "@milagre/shared/chats";
import { pullRequestState, type OrchestratorTask, type PullRequestState } from "@milagre/shared/orchestrator";
import type { CoordinatorState, LinkState, PullRequestSnapshot } from "../model";
import { pollWhileActive } from "../components/useWorktreePullRequests";
import { bridgeForKey } from "./computer-bridge";
import { taskScope } from "./orchestrator-board";

export function useOrchestratorPullRequests(tasks: readonly OrchestratorTask[], states: Record<string, CoordinatorState | LinkState>) {
  const [snapshots, setSnapshots] = useState<Record<string, PullRequestSnapshot>>({});
  const targets = tasks.flatMap((task) => {
    const scope = taskScope(task);
    const state = scope ? states[scope] : undefined;
    const session = task.sessionId === null ? undefined : state?.sessions[task.sessionId];
    const worktree = session && state && "worktrees" in state && "worktree_id" in session ? state.worktrees[session.worktree_id] : undefined;
    return scope && worktree ? [{ id: task.id, scope, path: worktree.path, refs: session?.summary?.pullRequests ?? [], lastAt: session?.summary?.lastAt }] : [];
  });
  const targetKey = JSON.stringify(targets);
  useEffect(() => {
    const selected = JSON.parse(targetKey) as typeof targets;
    const scopes = [...new Set(selected.map((entry) => entry.scope))];
    let disposed = false;
    const stops = scopes.map((scope) => {
      const bridge = bridgeForKey(scope);
      let reading = false;
      let lastRead = 0;
      const refresh = async () => {
        if (reading) return;
        reading = true;
        lastRead = Date.now();
        try {
          const snapshot = await bridge.readPullRequestSnapshot(scope);
          if (!disposed && snapshot) setSnapshots((current) => ({ ...current, [scope]: snapshot }));
        } catch {
          if (!disposed)
            setSnapshots((current) => {
              const next = { ...current };
              delete next[scope];
              return next;
            });
        } finally {
          reading = false;
        }
      };
      void refresh();
      const stopPolling = pollWhileActive(
        () => void refresh(),
        () => lastRead,
      );
      const stopEvents = bridge.onPullRequestsChanged((event) => {
        if (event.projectPath === scope) void refresh();
      });
      return () => {
        stopPolling();
        stopEvents();
      };
    });
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, [targetKey]);
  return useMemo(() => {
    const result: Record<string, PullRequestState> = {};
    for (const target of JSON.parse(targetKey) as typeof targets) {
      const snapshot = snapshots[target.scope];
      const prs = snapshot ? chatPullRequests(target.refs, snapshot.chats[target.path] ?? {}, snapshot.worktrees[target.path] ?? undefined) : [];
      result[target.id] = pullRequestState(prs.map((pr) => pr.state));
    }
    return result;
  }, [targetKey, snapshots]);
}

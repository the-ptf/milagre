import { useEffect, useMemo, useState } from "react";
import type { AgentRuns } from "@milagre/shared/agent-runs";
import { activeRoles } from "@milagre/shared/orchestrator";
import { boardCards, boardCounts, taskProjectPaths } from "./orchestrator-board";
import { useOrchestratorNames } from "./orchestrator-names";
import { useOrchestrator } from "./orchestrator-store";
import { useScopeStates } from "./sidebar-scopes";

const TICK_MS = 30_000;

export function useOrchestratorBoard(runs: AgentRuns) {
  const orchestrator = useOrchestrator();
  const names = useOrchestratorNames();
  const paths = taskProjectPaths(orchestrator.tasks);
  const { states } = useScopeStates(orchestrator.settings.enabled && paths.length > 0, paths);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const cards = useMemo(() => boardCards(orchestrator.tasks, states, runs, now), [orchestrator.tasks, states, runs, now]);
  const counts = useMemo(() => boardCounts(cards), [cards]);
  const roles = useMemo(() => activeRoles(orchestrator.settings.roles), [orchestrator.settings.roles]);
  const env = {
    color: orchestrator.settings.mascotColor,
    now,
    roles,
    projects: names.projects,
    accountLabels: names.accountLabels.length ? names.accountLabels : [names.accountLabel(null)],
    projectName: names.projectName,
    accountLabel: names.accountLabel,
  };
  return { orchestrator, cards, counts, env, names };
}

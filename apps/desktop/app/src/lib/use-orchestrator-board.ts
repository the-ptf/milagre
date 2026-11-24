import { useEffect, useMemo, useState } from "react";
import { activeRoles, type BoardColumn, type OrchestratorTask } from "@milagre/shared/orchestrator";
import { useComputers } from "./computers";
import { useDoneSettings } from "./done-settings";
import { boardCards, boardCounts, taskProjectPaths } from "./orchestrator-board";
import { useRuns } from "./agent-runs-store";
import { useOrchestratorNames } from "./orchestrator-names";
import { moveTask, useOrchestrator } from "./orchestrator-store";
import { undoHistory } from "./undo-history";
import { useScopeStates } from "./sidebar-scopes";
import { useTaskPullRequests } from "./use-task-pull-requests";

const TICK_MS = 30_000;
const MOVE_SETTLE_MS = 10_000;

export function useOrchestratorBoard() {
  const orchestrator = useOrchestrator();
  const runs = useRuns(orchestrator.settings.enabled && orchestrator.tasks.length > 0);
  const names = useOrchestratorNames();
  const { thisMac } = useComputers();
  const paths = taskProjectPaths(orchestrator.tasks);
  const { states } = useScopeStates(orchestrator.settings.enabled && paths.length > 0, paths);
  const pullRequests = useTaskPullRequests(paths, orchestrator.settings.enabled);
  const { retentionHours } = useDoneSettings().settings;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const derived = useMemo(
    () => boardCards(orchestrator.tasks, states, runs, now, pullRequests, retentionHours),
    [orchestrator.tasks, states, runs, now, pullRequests, retentionHours],
  );
  const [moved, setMoved] = useState<Readonly<Record<string, { column: BoardColumn; from: BoardColumn }>>>({});
  const forget = (taskId: string) =>
    setMoved((previous) => {
      const { [taskId]: _gone, ...rest } = previous;
      return rest;
    });
  const cards = useMemo(
    () =>
      derived.map((card) => {
        const move = moved[card.task.id];
        return move && card.column === move.from ? { ...card, column: move.column } : card;
      }),
    [derived, moved],
  );
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
    computerName: (task: OrchestratorTask) => task.computer ?? thisMac,
    onMove: (taskId: string, column: BoardColumn) => {
      const from = derived.find((card) => card.task.id === taskId)?.column;
      if (!from) return;
      setMoved((previous) => ({ ...previous, [taskId]: { column, from } }));
      window.setTimeout(() => forget(taskId), MOVE_SETTLE_MS);
      moveTask(taskId, column).catch((error: Error) => {
        forget(taskId);
        undoHistory.notify(`Couldn't move the task: ${error.message}`);
      });
    },
  };
  return { orchestrator, cards, counts, env, names };
}

import { ORCHESTRATOR_MENTION } from "@milagre/shared/prompt-parts";
import { orchestratorEnabled } from "./orchestrator-store";

/** The @ menu's Orchestrator row while it is on and the typed name fits. */
export function orchestratorMentionRows(open: boolean, query: string) {
  if (!open || !"orchestrator".startsWith(query.trim().toLowerCase()) || !orchestratorEnabled()) return [];
  return [{ key: "orchestrator", name: "Orchestrator", desc: "Hand this to the Orchestrator", computer: undefined, group: "Orchestrator" }];
}

export const isOrchestratorRow = (row: { key: string }) => row.key === "orchestrator";
export { ORCHESTRATOR_MENTION };

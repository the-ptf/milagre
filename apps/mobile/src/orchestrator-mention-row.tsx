import { ORCHESTRATOR_MENTION } from "@milagre/shared/prompt-parts";
import type { OrchestratorClient } from "./orchestrator-store";
import { ListRow } from "./ui";
import { useOrchestrator } from "./use-orchestrator";

/** The @ menu's Orchestrator row: shown while this computer has it on and the typed name fits. */
export function OrchestratorMentionRow({
  client,
  query,
  onPick,
}: {
  client: OrchestratorClient | null;
  query: string | undefined;
  onPick: (mention: string) => void;
}) {
  const on = !!useOrchestrator(query === undefined ? null : client).snapshot?.settings.enabled;
  if (!on || query === undefined || !"orchestrator".startsWith(query.toLowerCase())) return null;
  return <ListRow title="Orchestrator" subtitle="Hand this to the Orchestrator" onPress={() => onPick(ORCHESTRATOR_MENTION)} />;
}

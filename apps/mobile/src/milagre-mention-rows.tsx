import { BROWSER_MENTION, ORCHESTRATOR_MENTION } from "@milagre/shared/prompt-parts";
import type { OrchestratorClient } from "./orchestrator-store";
import { ListRow } from "./ui";
import { useOrchestrator } from "./use-orchestrator";

/** The @ menu's Milagre rows whose name fits the query: Orchestrator while this computer has it on, and Browser. */
export function MilagreMentionRows({
  client,
  query,
  onPick,
}: {
  client: OrchestratorClient | null;
  query: string | undefined;
  onPick: (mention: string) => void;
}) {
  const orchestrator = !!useOrchestrator(query === undefined ? null : client).snapshot?.settings.enabled;
  if (query === undefined) return null;
  const fits = (name: string) => name.startsWith(query.toLowerCase());
  return (
    <>
      {orchestrator && fits("orchestrator") && (
        <ListRow title="Orchestrator" subtitle="Hand this to the Orchestrator" onPress={() => onPick(ORCHESTRATOR_MENTION)} />
      )}
      {fits("browser") && <ListRow title="Browser" subtitle="Use Milagre's Browser panel" onPress={() => onPick(BROWSER_MENTION)} />}
    </>
  );
}

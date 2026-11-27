import { BROWSER_MENTION, PARADISE_MENTION, ORCHESTRATOR_MENTION, PARADISE_NAME, matchesParadiseMention } from "@milagre/shared/prompt-parts";
import type { OrchestratorClient } from "./orchestrator-store";
import { ListRow } from "./ui";
import { MentionIcon } from "./prompt-chip";
import { useOrchestrator } from "./use-orchestrator";

/** The @ menu's Milagre rows whose name fits the query. */
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
        <ListRow
          leading={<MentionIcon kind="orchestrator" />}
          title="Orchestrator"
          subtitle="Hand this to the Orchestrator"
          onPress={() => onPick(ORCHESTRATOR_MENTION)}
        />
      )}
      {matchesParadiseMention(query) && (
        <ListRow leading={<MentionIcon kind="paradise" />} title={PARADISE_NAME} subtitle={PARADISE_MENTION} onPress={() => onPick(PARADISE_MENTION)} />
      )}
      {fits("browser") && (
        <ListRow leading={<MentionIcon kind="browser" />} title="Browser" subtitle="Use Milagre's Browser panel" onPress={() => onPick(BROWSER_MENTION)} />
      )}
    </>
  );
}

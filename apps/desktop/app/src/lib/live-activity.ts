import { useMemo } from "react";
import type { ChatStep } from "../model";
import { loaderActivity } from "./reply-parts";
import { useRunTextValue } from "./agent-runs-store";
import { useSettings } from "./settings";

const NO_STEPS: ChatStep[] = [];

/** The running turn's live calls for the loader; Full detail keeps every call inline instead. */
export function useLiveActivity(
  chatKey: string | undefined,
  heldText: string | undefined,
  steps: ChatStep[] | undefined,
  waitingStepIds: readonly string[],
): ChatStep[] {
  const { toolCallDisplay } = useSettings();
  const ids = useRunTextValue(chatKey, (text) =>
    steps?.length && toolCallDisplay !== "full"
      ? loaderActivity((chatKey ? text : heldText) ?? "", steps, waitingStepIds)
          .map((step) => step.id)
          .join("\n")
      : "",
  );
  return useMemo(() => {
    if (!ids || !steps) return NO_STEPS;
    const live = new Set(ids.split("\n"));
    return steps.filter((step) => live.has(step.id));
  }, [ids, steps]);
}

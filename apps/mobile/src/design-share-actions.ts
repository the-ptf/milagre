import { useMemo, useState } from "react";
import { MAX_SHARED_SELECTION } from "@milagre/shared/artifact";
import { openArtifactShare } from "./artifact-page-menu";

/**
 * The share actions of a design's menu: the workspace, one design, and the presentation being picked, which keeps the
 * designs added to it in order and drops deleted ones. `choose` returns false for any other action.
 */
export function useDesignShareActions(hostId: string | undefined, chatId: string | undefined, designs: readonly { id: string }[]) {
  const [picked, setPicked] = useState<string[]>([]);
  const presentation = useMemo(() => {
    const present = new Set(designs.map((design) => design.id));
    return picked.filter((id) => present.has(id));
  }, [designs, picked]);
  const choose = (action: string, id: string) => {
    if (action === "share") openArtifactShare(hostId, chatId, "workspace");
    else if (action === "share-design") openArtifactShare(hostId, chatId, "design", id);
    else if (action === "present-toggle")
      setPicked(presentation.includes(id) ? presentation.filter((item) => item !== id) : [...presentation, id].slice(0, MAX_SHARED_SELECTION));
    else if (action === "share-presentation") openArtifactShare(hostId, chatId, "selection", undefined, presentation);
    else if (action === "present-clear") setPicked([]);
    else return false;
    return true;
  };
  return { presentation, choose };
}

import { useEffect, useSyncExternalStore } from "react";
import type { ArtifactRef } from "@milagre/shared/model";
import type { Client } from "./client";
import { designCatalog, readDesignCatalog, subscribeDesignCatalog } from "./design-catalog";

/** Historical refs lack a format. Resolve those against the host catalog. */
export function useArtifactCatalog(client: Client | null, chatId: string | undefined, refs: ArtifactRef[], enabled: boolean) {
  const catalog = useSyncExternalStore(subscribeDesignCatalog, () => designCatalog(client, chatId));
  const refsRevision = refs
    .filter((ref) => enabled || !ref.format)
    .map((ref) => `${ref.id}:${ref.version}`)
    .join("|");
  const revision = refsRevision ? `${enabled ? "designs-on" : "designs-off"}|${refsRevision}` : "";
  useEffect(() => {
    if (client && chatId && revision && !chatId.includes("#new:"))
      void readDesignCatalog(
        client,
        chatId,
        revision,
        refs.filter((ref) => !ref.format).map((ref) => ref.id),
        enabled,
      );
  }, [client, chatId, revision]);
  return (ref: ArtifactRef): "design" | "html" | null => {
    const format = ref.format ?? catalog?.find((item) => item.id === ref.id)?.format ?? null;
    return format === "html" ? "html" : enabled && format === "design" ? "design" : null;
  };
}

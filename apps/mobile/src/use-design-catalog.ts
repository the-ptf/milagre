import { useEffect, useSyncExternalStore } from "react";
import type { ArtifactRef } from "@milagre/shared/model";
import type { Client } from "./client";
import { designCatalog, readDesignCatalog, subscribeDesignCatalog } from "./design-catalog";

/** Historical refs lack a format. Confirm those against the host's structured-only catalog. */
export function useDesignCatalog(client: Client | null, chatId: string | undefined, refs: ArtifactRef[], enabled: boolean) {
  const catalog = useSyncExternalStore(subscribeDesignCatalog, () => designCatalog(client, chatId));
  const revision = refs.map((ref) => `${ref.id}:${ref.version}`).join("|");
  useEffect(() => {
    if (enabled && client && chatId && revision && !chatId.includes("#new:")) void readDesignCatalog(client, chatId, revision);
  }, [client, chatId, revision, enabled]);
  return (ref: ArtifactRef) => enabled && (ref.format === "design" || !!catalog?.some((design) => design.id === ref.id));
}

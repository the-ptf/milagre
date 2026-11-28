import { useEffect, useState } from "react";
import { designGroups, type ArtifactSummary } from "@milagre/shared/artifact";
import { openDesigns } from "./artifact";
import { OPEN_ARTIFACT, OPEN_PARADISE, artifactShortcuts, lastArtifactPage, rememberedTab } from "./artifact-pages";
import { usePanelTabs, type DesignsTab } from "./panel-tabs";
import { useRunShape, useSession } from "./session";

type Caller = { url: string; call: <T>(method: string, args: unknown[]) => Promise<T> };
type Found = { key: string; designs: ArtifactSummary[]; page: ArtifactSummary | null };

/**
 * Paradise and the HTML page of a Chat, as entries of its ⋯ menu and its New tab: each shows once the Chat has one, and
 * `select` opens it (the design or tab last viewed there) through `open`, else in the iPad's panel or full screen on a phone.
 */
export function useArtifactShortcuts(client: Caller | null, projectPath: string | undefined, id: string | undefined, open?: (target: DesignsTab) => void) {
  const { snapshot, designs: feature } = useSession();
  const openTab = usePanelTabs();
  const show = (target: DesignsTab) => (open ? open(target) : openDesigns(openTab, target));
  const chatId = projectPath && id ? `${projectPath}#${id}` : undefined;
  const run = !!useRunShape(chatId);
  const lastId = id && snapshot?.project.path === projectPath ? snapshot?.project.state.sessions[Number(id)]?.summary?.lastId : undefined;
  const key = client && chatId ? `${client.url}|${chatId}` : "";
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    if (!client || !chatId) return;
    let live = true;
    client
      .call<ArtifactSummary[]>("artifact:list", [{ chatId }])
      .then((list) => {
        if (!live || !Array.isArray(list)) return;
        const designs = designGroups(list.filter((item) => item.format === "design")).flatMap((row) => row.designs);
        setFound({ key: `${client.url}|${chatId}`, designs, page: list.find((item) => item.format === "html") ?? null });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, chatId, lastId, run]);
  const shown = found?.key === key ? found : null;
  const designs = feature.enabled === true ? (shown?.designs ?? []) : [];
  const page = shown?.page ?? null;
  const items = artifactShortcuts(designs.length, page);
  const select = (choice: string) => {
    if (!client || !chatId || (choice !== OPEN_PARADISE && choice !== OPEN_ARTIFACT)) return false;
    const hostId = client.url;
    if (choice === OPEN_ARTIFACT && page) {
      const tab = rememberedTab(hostId, chatId, page.id);
      show({ hostId, chatId, id: page.id, html: true, ...(tab ? { tab } : {}) });
    }
    const last = lastArtifactPage(hostId, chatId)?.design;
    const design = designs.find((item) => item.id === last) ?? designs[0];
    if (choice === OPEN_PARADISE && design) show({ hostId, chatId, id: design.id });
    return true;
  };
  return { items, select };
}

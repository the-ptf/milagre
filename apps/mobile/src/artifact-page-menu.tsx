import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { designGroups, libraryProject, type Artifact, type ArtifactPageKind, type ArtifactSummary, type DesignLibrary } from "@milagre/shared/artifact";
import {
  OPEN_DESIGN_LIBRARY,
  artifactPageSections,
  artifactRouteParams,
  lastArtifactPage,
  pageEntries,
  readPageChoice,
  rememberedTab,
  type ArtifactPageChoice,
  type ArtifactPageEntry,
} from "./artifact-pages";
import type { DesignsTab } from "./panel-tabs";
import { openDesignLibrary } from "./design-library-route";
import type { MenuSection } from "./primitives/menu";
import { lineHeight, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { PullDown, useStyles } from "./ui";

type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };

/** The Artifact header's title. With more than one page to show it opens the page menu: Paradise and the HTML page. */
export function ArtifactPageTitle({
  title,
  subtitle,
  sections,
  onSelect,
}: {
  title: string;
  subtitle: string;
  sections: MenuSection[];
  onSelect: (id: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const menu = pageEntries(sections) > 1;
  const body = (
    <View style={{ alignItems: "center", gap: 2 }}>
      <Text accessibilityRole="header" numberOfLines={1} style={[styles.sheetTitle, { textAlign: "center" }]}>
        {title}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        {subtitle ? (
          <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
            {subtitle}
          </Text>
        ) : null}
        {menu && <Icon icon={UnfoldMoreIcon} size={12} tone="ink3" />}
      </View>
    </View>
  );
  if (!menu) return <View style={{ flex: 1 }}>{body}</View>;
  return (
    <PullDown label={`${title}, ${subtitle}. Choose a page`} style={{ flex: 1, alignItems: "center" }} sections={sections} onSelect={onSelect}>
      {body}
    </PullDown>
  );
}

/**
 * Shows another page of the Artifact in place: in the iPad's panel tab through `onPage`, else by replacing the phone
 * sheet's params, so it neither pushes nor pops.
 */
export function showArtifactPage(target: DesignsTab, onPage?: (target: DesignsTab) => void) {
  if (onPage) onPage(target);
  else router.setParams(artifactRouteParams(target));
}

/**
 * The page menu of a page of the Artifact (`current`): its sections, and what choosing one does. Canvas opens the
 * design last viewed there (else the first); the HTML page opens the tab chosen, else the one last viewed; a Project
 * library page opens its first design.
 */
export function artifactPageMenu({
  hostId,
  chatId,
  designs,
  page,
  library: shared,
  current,
  onPage,
  onTab,
}: {
  hostId?: string;
  chatId?: string;
  designs: { id: string }[];
  page: { id: string; title: string; tabs: ArtifactPageEntry[] } | null;
  library?: DesignLibrary | null;
  current: ArtifactPageChoice;
  onPage?: (target: DesignsTab) => void;
  onTab?: (tab: string) => void;
}) {
  const library = shared?.pages ?? [];
  const sections = artifactPageSections({ canvas: designs.length > 0, page, library, current, openLibrary: true });
  const choose = (id: string) => {
    if (id === OPEN_DESIGN_LIBRARY && hostId && chatId) {
      const project = libraryProject(chatId);
      openDesignLibrary(hostId, project, project.split("/").findLast(Boolean) ?? project);
      return;
    }
    const picked = readPageChoice(id);
    if (!picked || !hostId || !chatId) return;
    if (picked.kind === "library") {
      const shown = library.find((item) => item.id === picked.page);
      if (shown?.designs[0] && (current.kind !== "library" || current.page !== picked.page))
        showArtifactPage({ hostId, chatId, id: shown.designs[0].id, library: shown.id }, onPage);
    } else if (picked.kind === "canvas") {
      const last = lastArtifactPage(hostId, chatId)?.design;
      const design = designs.find((item) => item.id === last) ?? designs[0];
      if (current.kind !== "canvas" && design) showArtifactPage({ hostId, chatId, id: design.id }, onPage);
    } else if (current.kind === "page") {
      if (picked.tab !== current.tab) onTab?.(picked.tab);
    } else if (page) {
      const tab = picked.tab || rememberedTab(hostId, chatId, page.id);
      showArtifactPage({ hostId, chatId, id: page.id, html: true, ...(tab ? { tab } : {}) }, onPage);
    }
  };
  return { sections, choose };
}

/** Opens the Share sheet for a scope: `designId` names one design, `designIds` the designs of a presentation in order. */
export function openArtifactShare(hostId: string | undefined, chatId: string | undefined, kind: ArtifactPageKind, designId?: string, designIds?: string[]) {
  if (hostId && chatId)
    router.push({
      pathname: "/design-share-sheet",
      params: { hostId, chatId, kind, ...(designId ? { designId } : {}), ...(designIds?.length ? { designIds: designIds.join(",") } : {}) },
    });
}

/** The Chat's designs in the canvas's order, for the Artifact page's menu to offer Canvas; none while `enabled` is off. */
export function useChatDesigns(source: Caller | null, chatId: string | undefined, revision: unknown, enabled: boolean): ArtifactSummary[] {
  const [designs, setDesigns] = useState<{ key: unknown; list: ArtifactSummary[] }>({ key: null, list: [] });
  const key = enabled && source && chatId ? source : null;
  useEffect(() => {
    if (!key || !chatId) return;
    let live = true;
    key
      .call<ArtifactSummary[]>("artifact:list", [{ chatId, format: "design" }])
      .then((list) => {
        if (!live) return;
        const found = Array.isArray(list) ? list.filter((item) => item.format === "design") : [];
        setDesigns({ key, list: designGroups(found).flatMap((row) => row.designs) });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, chatId, revision]);
  return designs.key === key && key ? designs.list : [];
}

/** The tabs of the Chat's HTML page, for the page menu of the canvas; none while `page` is null or loading. */
export function usePageTabs(source: Caller | null, chatId: string | undefined, page: ArtifactSummary | null): ArtifactPageEntry[] {
  const [tabs, setTabs] = useState<{ key: string; tabs: ArtifactPageEntry[] }>({ key: "", tabs: [] });
  const id = page?.id;
  const version = page?.version;
  const key = source && chatId && id ? `${chatId}|${id}|${version}` : "";
  useEffect(() => {
    if (!source || !chatId || !id) return;
    let live = true;
    source
      .call<Artifact>("artifact:get", [{ chatId, id }])
      .then((artifact) => {
        if (live && artifact?.format === "html")
          setTabs({ key: `${chatId}|${id}|${version}`, tabs: (artifact.tabs ?? []).map((tab) => ({ id: tab.id, title: tab.title })) });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [source, chatId, id, version]);
  return tabs.key === key ? tabs.tabs : [];
}

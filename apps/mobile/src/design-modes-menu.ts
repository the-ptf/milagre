import type { Artifact } from "@milagre/shared/artifact";
import { DESIGN_MODE_LABELS, DESIGN_MODES, designHtmlForMode, designModesOf, type DesignMode } from "@milagre/shared/design-modes";
import type { MenuSection } from "./ui";
import { versionSections } from "./artifact-pages.ts";

/** The modes a loaded design can show in; one entry when its tokens define no dark or contrast values. */
const designModesFor = (artifact: Artifact | undefined): DesignMode[] =>
  artifact?.format === "design" && artifact.document ? designModesOf(artifact.document) : ["light"];

/** The mode a design is shown in: the chosen one while the design still defines it, otherwise light. */
export const shownDesignMode = (artifact: Artifact | undefined, chosen: DesignMode | undefined): DesignMode =>
  chosen && designModesFor(artifact).includes(chosen) ? chosen : "light";

/** The Appearance section of a design's actions menu, with `mode:<name>` items. */
export function designModeMenu(artifact: Artifact | undefined, chosen: DesignMode | undefined): MenuSection[] {
  const modes = designModesFor(artifact);
  if (modes.length < 2) return [];
  const shown = shownDesignMode(artifact, chosen);
  return [{ title: "Appearance", items: modes.map((mode) => ({ id: `mode:${mode}`, title: DESIGN_MODE_LABELS[mode], checked: mode === shown })) }];
}

const PAGE_MODE = "page-mode:";

/**
 * The Appearance section for every design on a page, with `page-mode:<name>` items: the modes any of them defines, the
 * one checked when they all show it. None when no design defines Dark or Contrast.
 */
export function pageModeMenu(artifacts: readonly Artifact[], chosen: Record<string, DesignMode>): MenuSection[] {
  const offered = DESIGN_MODES.filter((mode) => artifacts.some((artifact) => designModesFor(artifact).includes(mode)));
  if (offered.length < 2) return [];
  const shown = new Set(artifacts.map((artifact) => shownDesignMode(artifact, chosen[artifact.id])));
  const common = shown.size === 1 ? [...shown][0] : null;
  return [{ title: "Appearance", items: offered.map((mode) => ({ id: `${PAGE_MODE}${mode}`, title: DESIGN_MODE_LABELS[mode], checked: mode === common })) }];
}

/** The choices a `page-mode:<name>` action makes: that mode for each design defining it, light for the rest; null for any other action. */
export function pageModeChoices(artifacts: readonly Artifact[], action: string): Record<string, DesignMode> | null {
  if (!action.startsWith(PAGE_MODE)) return null;
  const mode = action.slice(PAGE_MODE.length) as DesignMode;
  return Object.fromEntries(artifacts.map((artifact) => [artifact.id, designModesFor(artifact).includes(mode) ? mode : "light"]));
}

/** The mode named beside a design's title, or "" in light. */
export const designModeLabel = (artifact: Artifact | undefined, chosen: DesignMode | undefined) => {
  const mode = shownDesignMode(artifact, chosen);
  return mode === "light" ? "" : DESIGN_MODE_LABELS[mode];
};

const SHARE_SECTION: MenuSection = {
  items: [
    { id: "share", title: "Share", systemImage: "square.and.arrow.up" },
    { id: "share-design", title: "Share this design" },
  ],
};

/** A design's actions menu: resolved comments, choose, appearance, versions, share, then `extra` (the Project library) and delete. */
export function designActionsMenu({
  shown,
  latest,
  showResolved,
  chosen,
  sent,
  sharing,
  mode,
  extra,
}: {
  shown: Artifact | undefined;
  latest: number;
  showResolved: boolean;
  chosen: boolean;
  sent: boolean;
  sharing: boolean;
  mode: DesignMode | undefined;
  extra: MenuSection[];
}): MenuSection[] {
  if (!shown) return [];
  return [
    { items: [{ id: "resolved", title: "Show resolved comments", checked: showResolved }] },
    { items: [{ id: "choose", title: chosen ? "Chosen" : "Choose this design", checked: chosen, disabled: sent }] },
    ...designModeMenu(shown, mode),
    ...versionSections(latest, shown.version),
    ...(sharing ? [SHARE_SECTION] : []),
    ...extra,
    { items: [{ id: "delete", title: "Delete design", systemImage: "trash", destructive: true }] },
  ];
}

/** The HTML a layer design sends to the canvas page in its shown mode. */
export const designHtmlIn = (artifact: Artifact, chosen: DesignMode | undefined) =>
  artifact.format === "design" && !artifact.interactive ? designHtmlForMode(artifact.html, shownDesignMode(artifact, chosen)) : artifact.html;

import type { Artifact } from "@milagre/shared/artifact";
import { DESIGN_MODE_LABELS, designHtmlForMode, designModesOf, type DesignMode } from "@milagre/shared/design-modes";
import type { MenuSection } from "./ui";

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

/** The mode named beside a design's title, or "" in light. */
export const designModeLabel = (artifact: Artifact | undefined, chosen: DesignMode | undefined) => {
  const mode = shownDesignMode(artifact, chosen);
  return mode === "light" ? "" : DESIGN_MODE_LABELS[mode];
};

/** A design's actions menu: resolved comments, choose, appearance, versions, share and delete. */
export function designActionsMenu({
  shown,
  latest,
  showResolved,
  chosen,
  sent,
  sharing,
  mode,
}: {
  shown: Artifact | undefined;
  latest: number;
  showResolved: boolean;
  chosen: boolean;
  sent: boolean;
  sharing: boolean;
  mode: DesignMode | undefined;
}): MenuSection[] {
  if (!shown) return [];
  return [
    { items: [{ id: "resolved", title: "Show resolved comments", checked: showResolved }] },
    { items: [{ id: "choose", title: chosen ? "Chosen" : "Choose this design", checked: chosen, disabled: sent }] },
    ...designModeMenu(shown, mode),
    ...(latest > 1
      ? [
          {
            title: "Versions",
            items: Array.from({ length: latest }, (_, index) => latest - index).map((number) => ({
              id: `version:${number}`,
              title: `Version ${number}${number === latest ? " (latest)" : ""}`,
              checked: number === shown.version,
            })),
          },
        ]
      : []),
    ...(sharing ? [{ items: [{ id: "share", title: "Share page", systemImage: "square.and.arrow.up" }] }] : []),
    { items: [{ id: "delete", title: "Delete design", systemImage: "trash", destructive: true }] },
  ];
}

/** The HTML a layer design sends to the canvas page in its shown mode. */
export const designHtmlIn = (artifact: Artifact, chosen: DesignMode | undefined) =>
  artifact.format === "design" && !artifact.interactive ? designHtmlForMode(artifact.html, shownDesignMode(artifact, chosen)) : artifact.html;

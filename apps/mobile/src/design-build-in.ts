import { useCallback, useEffect, useMemo } from "react";
import { designBuildHtml, designBuildLayers } from "@milagre/shared/design-build";
import { artifactDocument, isInteractiveDesign, type Artifact, type ArtifactSummary } from "@milagre/shared/artifact";
import type { DesignMode } from "@milagre/shared/design-modes";
import type { DesignDocument } from "@milagre/shared/design";
import { designHtmlIn } from "./design-modes-menu";
import { useReducedMotion } from "./motion";

type Shown = { version: number; document: DesignDocument | null };

/**
 * Versions that land while the canvas is open build in layer by layer, as the desktop replays them; the designs the
 * canvas opened with, a pinned older version and a resend of a version already shown go on as they are.
 */
function createDesignBuildIn() {
  let opened: Map<string, number> | null = null;
  const shown = new Map<string, Shown>();
  return {
    open(summaries: readonly ArtifactSummary[]) {
      opened ??= new Map(summaries.map((summary) => [summary.id, summary.version]));
    },
    html(artifact: Artifact, html: string, { following, motion, accent }: { following: boolean; motion: boolean; accent: string }) {
      if (artifact.format !== "design" || !artifact.document) return html;
      const before = shown.get(artifact.id);
      if (before?.version === artifact.version) return html;
      shown.set(artifact.id, { version: artifact.version, document: artifact.document });
      const landed = !!opened && artifact.version > (opened.get(artifact.id) ?? 0) && (!before || artifact.version > before.version);
      if (!landed || !following || !motion) return html;
      return designBuildHtml(html, designBuildLayers(before?.document, artifact.document), accent);
    },
  };
}

/** The canvas page for a design in `mode`: built in when it just landed and the canvas follows its latest version. */
export function useDesignBuildIn(source: unknown, chatId: string | undefined, summaries: readonly ArtifactSummary[] | null, accent: string) {
  const motion = !useReducedMotion();
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- a new host or Chat starts a new canvas
  const buildIn = useMemo(() => createDesignBuildIn(), [source, chatId]);
  useEffect(() => {
    if (summaries) buildIn.open(summaries);
  }, [buildIn, summaries]);
  return useCallback(
    (artifact: Artifact, mode: DesignMode | undefined, following: boolean) =>
      artifactDocument(buildIn.html(artifact, designHtmlIn(artifact, mode), { following, motion, accent }), { code: isInteractiveDesign(artifact) }),
    [buildIn, motion, accent],
  );
}

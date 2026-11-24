import type { DesignDocument } from "./design.mjs";
import type { ArtifactAsset } from "./artifact-assets.mjs";
export interface DesignPageSnapshot {
  schemaVersion: 1;
  title: string;
  /** A design's group names the block it sits in, as on the desktop Canvas; designs without one share a block. */
  designs: ({ title: string; group?: string } & (
    | { document: DesignDocument; interactive?: never }
    | { interactive: { html: string; width: number; height: number }; document?: never }
  ))[];
}
export interface ArtifactPageSnapshot {
  schemaVersion: 1;
  kind: "artifacts";
  title: string;
  artifacts: { title: string; html: string; width: number; height: number; assets?: ArtifactAsset[] }[];
}
/** The Artifact panel's Share: every design and, when the Chat has one, its HTML page, drawn first on the canvas. */
export interface WorkspacePageSnapshot {
  schemaVersion: 1;
  kind: "workspace";
  title: string;
  designs: DesignPageSnapshot["designs"];
  page?: ArtifactPageSnapshot["artifacts"][number];
}
export type PageSnapshot = DesignPageSnapshot | ArtifactPageSnapshot | WorkspacePageSnapshot;
export function validateDesignPageSnapshot(value: unknown): PageSnapshot;
export function isSnapshotRaster(source: string): boolean;
export function designPageRunsCode(snapshot: PageSnapshot | null | undefined): boolean;
/** The files a published page names, which the host uploads before the snapshot and the service serves beside it. */
export function pageAssets(snapshot: PageSnapshot | null | undefined): ArtifactAsset[];
/** `files` gives the public URL of an Artifact page's file, which its HTML names `assets/<name>`. */
export function renderDesignPage(snapshot: PageSnapshot, options?: { files?: (asset: ArtifactAsset) => string }): string;

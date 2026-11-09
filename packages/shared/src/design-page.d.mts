import type { DesignDocument } from "./design.mjs";
import type { ArtifactAsset } from "./artifact-assets.mjs";
export interface DesignPageSnapshot {
  schemaVersion: 1;
  title: string;
  /** A design's group names the block it sits in, as on the desktop Canvas; designs without one share a block. */
  designs: { title: string; group?: string; document: DesignDocument }[];
}
export interface ArtifactPageSnapshot {
  schemaVersion: 1;
  kind: "artifacts";
  title: string;
  artifacts: { title: string; html: string; width: number; height: number; assets?: ArtifactAsset[] }[];
}
export function validateDesignPageSnapshot(value: unknown): DesignPageSnapshot | ArtifactPageSnapshot;
export function isSnapshotRaster(source: string): boolean;
/** `files` gives the public URL of an Artifact page's file, which its HTML names `assets/<name>`. */
export function renderDesignPage(snapshot: DesignPageSnapshot | ArtifactPageSnapshot, options?: { files?: (asset: ArtifactAsset) => string }): string;

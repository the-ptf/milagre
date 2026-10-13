import type { DesignDocument } from "./design.mjs";
export interface DesignPageSnapshot {
  schemaVersion: 1;
  title: string;
  designs: { title: string; document: DesignDocument }[];
}
export interface ArtifactPageSnapshot {
  schemaVersion: 1;
  kind: "artifacts";
  title: string;
  artifacts: { title: string; html: string; width: number; height: number }[];
}
export const MAX_DESIGN_PAGE_BYTES: number;
export const MAX_DESIGN_PAGE_HTML_BYTES: number;
export const MAX_DESIGN_PAGE_TEXT_CHARACTERS: number;
export const DESIGN_PAGE_PUBLIC_NOTICE: string;
export function validateDesignPageSnapshot(value: unknown): DesignPageSnapshot | ArtifactPageSnapshot;
export function isSnapshotRaster(source: string): boolean;
export function renderDesignPage(snapshot: DesignPageSnapshot | ArtifactPageSnapshot): string;

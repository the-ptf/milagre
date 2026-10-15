import type { DesignDocument } from "./design.mjs";

/** The start of a JSON text still being written: whole members and items, and the container being written, partial. */
export function parsePartialJson(text: string): unknown;

export interface DesignDraftSnapshot {
  /** The design the call writes to, once its input names it. */
  designId: string | null;
  title: string | null;
  group: string | null;
  /** What renders so far, or null before the screen's size (or design_apply's base) is known. */
  document: DesignDocument | null;
  /** The layers this read added or changed, in document order. */
  changed: string[];
}

export interface DesignDraft {
  read(input: string, base?: DesignDocument | null): DesignDraftSnapshot;
}

/** Follows one design_show or design_apply call while its input streams in. */
export function createDesignDraft(tool: "design_show" | "design_apply"): DesignDraft;

/** The layers `after` adds or changes, in its order, and the ids it no longer has. */
export function designChanges(before: DesignDocument, after: DesignDocument): { changed: string[]; removed: string[] };

/** A finished change as at most `maxSteps` steps, layers in reading order; the last step is `after`. */
export function designReplay(before: DesignDocument, after: DesignDocument, maxSteps?: number): { document: DesignDocument; changed: string[] }[];

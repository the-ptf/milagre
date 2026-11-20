import type { DesignDocument } from "./design.mjs";

/** The layers of `after` that `before` lacks or draws differently, in document order; every layer without `before`. */
export function designBuildLayers(before: DesignDocument | null | undefined, after: DesignDocument): string[];

/** A saved layer design's page that fades `layers` in one after another with an `accent` outline, for a version that just landed. */
export function designBuildHtml(html: string, layers: string[], accent?: string): string;

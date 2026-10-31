import type { DesignDocument } from "./design.mjs";
export function designImageDocument(document: DesignDocument, keep?: (src: string) => boolean): DesignDocument;
export function designPreviewDocument(document: DesignDocument): DesignDocument;

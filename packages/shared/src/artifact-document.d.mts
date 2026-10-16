export const ARTIFACT_CSP: string;
export function artifactDocument(html: string): string;
export const ARTIFACT_ESCAPE: "milagre:artifact-escape";
export const ARTIFACT_SEND: "milagre:artifact-send";
export const ARTIFACT_ESCAPE_SCRIPT: string;
export function artifactShell(html: string): string;
export const DESIGN_CANVAS_SCRIPT: string;
export function designCanvasShell(html: string, size: { width: number; height: number }, background?: string): string;

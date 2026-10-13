import type { z } from "zod";
export { DESIGN_CONTROLLER_SCRIPT } from "./design-controller-script.mjs";
/** Lucide icon name to SVG inner markup. */
export const designIcons: Record<string, string>;
export const designInterFonts: Record<"400" | "500" | "600" | "700", string>;
/** Build-time only: regenerate the checked-in controller after editing its source. */
export function buildDesignControllerScript(): string;

/** An editable screen. Nodes are stored flat and ordered back to front within each parent. */
export interface DesignDocument {
  schemaVersion: 1;
  width: number;
  height: number;
  background?: string;
  tokens?: Record<string, string>;
  nodes: DesignNode[];
}

export interface DesignNode {
  id: string;
  name?: string;
  type: "frame" | "text" | "rectangle" | "ellipse" | "image" | "icon";
  parentId?: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  widthMode?: "fixed" | "hug" | "fill";
  heightMode?: "fixed" | "hug" | "fill";
  minWidth?: number;
  minHeight?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  lineHeight?: number;
  textAlign?: "left" | "center" | "right";
  src?: string;
  icon?: string;
  layout?: "free" | "horizontal" | "vertical";
  gap?: number;
  padding?: number;
  align?: "start" | "center" | "end";
  justify?: "start" | "center" | "end" | "space-between";
  hidden?: boolean;
  locked?: boolean;
  component?: boolean;
  componentId?: string;
  componentSourceId?: string;
}

export type DesignOperation =
  | { op: "update"; id: string; patch: Partial<Omit<DesignNode, "id">> }
  | { op: "insert"; node: DesignNode; index?: number }
  | { op: "delete"; id: string }
  | { op: "replace"; document: DesignDocument };

export interface DesignBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const designDocumentSchema: z.ZodType<DesignDocument>;
export const designOperationSchema: z.ZodType<DesignOperation>;
export function validateDesignDocument(value: unknown): DesignDocument;
export function applyDesignOperations(document: DesignDocument, operations: DesignOperation[]): DesignDocument;
export function diffDesignDocuments(before: DesignDocument, after: DesignDocument): DesignOperation[];
export function designLayout(document: DesignDocument, textLayout?: typeof designTextLayout): Map<string, DesignBounds>;
export function designTextLayout(node: DesignNode, width?: number): { lines: string[]; width: number; height: number; lineHeight: number };
export function designInstanceRoot(document: DesignDocument, nodeId: string, byId?: ReadonlyMap<string, DesignNode>): DesignNode | null;
export function createDesignInstance(
  document: DesignDocument,
  componentId: string,
  instanceId: string,
  position?: { x?: number; y?: number; parentId?: string },
): DesignOperation[];
export function detachDesignInstance(document: DesignDocument, instanceId: string): DesignOperation[];
/** The frontmost visible layer at a screen coordinate, respecting clipped parent frames. */
export function designNodeAt(document: DesignDocument, x: number, y: number): DesignNode | null;
export interface DesignWarning {
  id: string;
  kind: "clipped-text" | "overflow" | "off-canvas" | "low-contrast" | "remote-image";
  message: string;
}
/** Problems an agent can't see in JSON: cut-off text, layers outside their parent or the screen, unreadable text, remote images. */
export function designWarnings(document: DesignDocument): DesignWarning[];
/** At most 20 warning lines plus "…and N more", or "" when there are none. */
export function designWarningText(warnings: DesignWarning[]): string;
export function designColor(document: DesignDocument, value?: string, fallback?: string): string;
/** Serialize plain family names as CSS, preserving generic fallback families. */
export function designFontFamily(value?: string): string;
/** CSS @font-face rules (data URIs) for the Inter weights a document's visible text uses, or "". */
export function designFontFaces(document: DesignDocument): string;
/** The measured Inter weight a requested weight renders with. */
export function designInterWeight(fontWeight?: number): 400 | 500 | 600 | 700;
/** Whether Inter is the first family in a font-family list, so the document renders in the embedded Inter. */
export function designUsesInter(fontFamily?: string): boolean;
export function designHtml(document: DesignDocument, options?: { interactive?: boolean; selectedId?: string | null }): string;
/** A portable SVG with native shapes, text and image elements. Inter is embedded unless `embedFonts` is false. JSON is the lossless design export. */
export function designSvg(document: DesignDocument, options?: { embedFonts?: boolean }): string;
export function createExampleDesign(): DesignDocument;

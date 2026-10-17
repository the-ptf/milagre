import type { z } from "zod";
export { DESIGN_CONTROLLER_SCRIPT } from "./design-controller-script.mjs";
/** Lucide icon name to SVG inner markup. */
export const designIcons: Record<string, string>;
export const designInterFonts: Record<"400" | "500" | "600" | "700", string>;
/** The color text and icons draw in when they name no fill. */
export const DESIGN_INK: "#202720";
/** The grey a shape, or an image still to add, paints when it names no fill. */
export const DESIGN_PLACEHOLDER: "#d8ded8";
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
/** The looser shapes design_show and design_apply advertise to agents; the saved document is checked strictly. */
export const designDocumentInputSchema: z.ZodType<unknown>;
export const designOperationInputSchema: z.ZodType<unknown>;
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
/** CSS @font-face rules (data URIs) for the Inter and loaded catalog weights a document's visible text uses, or "". */
export function designFontFaces(document: DesignDocument): string;
/** The catalog families a design can name besides Inter, measured and bundled like Inter. */
export const DESIGN_CATALOG_FAMILIES: string[];
/** The catalog entry for the first family of a font-family list, if it is in the catalog. */
export function designCatalogFont(fontFamily?: string): { family: string; weights: number[]; advances: Record<string, number[]> } | undefined;
/** The weight a text layer draws with: the nearest measured face in Inter or a catalog family, as requested otherwise. */
export function designDrawnWeight(fontFamily?: string, fontWeight?: number): number;
/** Loads the catalog families a document names, so designHtml, designSvg and designFontBuffers can embed them. */
export function loadDesignFonts(document: DesignDocument): Promise<void>;
/** Whether every catalog family a document names is loaded. */
export function designFontsLoaded(document: DesignDocument): boolean;
/** TrueType data (base64) for a rasterizer: every Inter weight plus the loaded catalog faces the document uses. */
export function designFontBuffers(document: DesignDocument): string[];
/** The measured Inter weight a requested weight renders with. */
export function designInterWeight(fontWeight?: number): 400 | 500 | 600 | 700;
/** Whether Inter is the first family in a font-family list, so the document renders in the embedded Inter. */
export function designUsesInter(fontFamily?: string): boolean;
/** What a layer paints when it names no fill: frames and images that have a source stay transparent. */
export function designDefaultFill(node: Pick<DesignNode, "type" | "src">): string;
/** Whether the bundled Inter subset has a glyph for this character; whitespace always counts as drawable. */
export function designInterHasGlyph(character: string): boolean;
export function designHtml(document: DesignDocument, options?: { interactive?: boolean; selectedId?: string | null }): string;
/** The parts of designHtml's page, for a page that swaps them in place: root markup, background, font faces and layer bounds. */
export function designLiveParts(document: DesignDocument): {
  width: number;
  height: number;
  background: string;
  fontFaces: string;
  markup: string;
  bounds: Map<string, DesignBounds>;
};
/** A portable SVG with native shapes, text and image elements. Inter and loaded catalog faces are embedded unless `embedFonts` is false. JSON is the lossless design export. */
export function designSvg(document: DesignDocument, options?: { embedFonts?: boolean; onCanvasOnly?: boolean }): string;
export function createExampleDesign(): DesignDocument;

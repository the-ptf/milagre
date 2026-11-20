import type { z } from "zod";
import type { DesignMode } from "./design-modes.mjs";
export type { DesignMode } from "./design-modes.mjs";
export { DESIGN_MODES, DESIGN_MODE_LABELS, designHtmlForMode, designModesOf } from "./design-modes.mjs";
/** A color token: one color for every mode, or one per mode (light required). */
export type DesignColorToken = string | { light: string; dark?: string; contrast?: string };
export const designIcons: Record<string, string>;
export const DESIGN_INK: "#202720";
export const DESIGN_PLACEHOLDER: "#d8ded8";

/** An editable screen. Nodes are stored flat and ordered back to front within each parent. */
export interface DesignDocument {
  schemaVersion: 1;
  width: number;
  height: number;
  background?: string;
  kit?: DesignKit;
  consistency?: {
    mode: "advisory" | "strict";
    exceptions?: Array<{ nodeId: string; field: string; value: string | number | Record<string, string | number>; reason: string }>;
  };
  tokens?: Record<string, DesignColorToken>;
  nodes: DesignNode[];
}

export interface DesignKit {
  id: string;
  version: number;
  title: string;
  colors: Record<string, DesignColorToken>;
  textStyles: Record<string, { fontFamily?: string; fontSize: number; fontWeight?: number; lineHeight?: number; letterSpacing?: number }>;
  spacing: Record<string, number>;
  radii: Record<string, number>;
  tracking?: Record<string, number>;
  opacity?: Record<string, number>;
  components?: Record<string, DesignNode[]>;
  references?: Array<{ title: string; source: string }>;
}
export const designKitSchema: z.ZodType<DesignKit>;
export const designKitDataSchema: z.ZodType<Omit<DesignKit, "id" | "version">>;
export function validateDesignKit(value: unknown): DesignKit;

export interface DesignNode {
  id: string;
  name?: string;
  type: "frame" | "text" | "rectangle" | "ellipse" | "image" | "icon" | "path";
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
  letterSpacing?: number;
  textAlign?: "left" | "center" | "right";
  src?: string;
  icon?: string;
  /** A path layer's SVG path data, in viewBox units (the layer's pixels by default). */
  path?: string;
  viewBox?: [number, number, number, number];
  /** Instead of path: a ring arc, start degrees clockwise from 12 o'clock for sweep degrees. */
  arc?: { start?: number; sweep: number };
  strokeCap?: "butt" | "round" | "square";
  strokeJoin?: "miter" | "round" | "bevel";
  strokeDash?: number[];
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
  textStyle?: string;
  bindings?: Partial<Record<"padding" | "gap" | "minWidth" | "minHeight" | "radius" | "letterSpacing" | "opacity", string>>;
  componentProperties?: Record<string, { nodeId: string; field: "text" | "icon" | "hidden" | "fill" | "opacity"; options?: Array<string | boolean | number> }>;
  componentValues?: Record<string, string | boolean | number>;
}

export type DesignOperation =
  | { op: "update"; id: string; patch: Partial<Omit<DesignNode, "id">> }
  | { op: "insert"; node: DesignNode; index?: number }
  | { op: "delete"; id: string }
  | { op: "replace"; document: DesignDocument }
  | { op: "document"; patch: Partial<Omit<DesignDocument, "nodes" | "schemaVersion">> }
  | { op: "detach"; id: string }
  | { op: "duplicate"; id: string; newId: string; x?: number; y?: number }
  | { op: "unset"; id: string; fields: Array<"parentId" | "textStyle" | "bindings" | "componentValues"> };

export interface DesignEditIntent {
  mode: "text-only" | "fit-text";
  textIds: string[];
  layoutIds?: string[];
}
export const designEditIntentSchema: z.ZodType<DesignEditIntent>;

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
export function validateDesignConsistency(document: DesignDocument): DesignDocument;
export function applyDesignOperations(document: DesignDocument, operations: DesignOperation[], intent?: DesignEditIntent): DesignDocument;
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
  blockerId?: string;
  measurements?: Record<string, number>;
  suggestions?: Array<{ label: string; operations?: DesignOperation[]; requiresValidation: true }>;
  id: string;
  field?: string;
  actual?: string | number | Record<string, string | number>;
  path?: Array<string | number>;
  kind: "clipped-text" | "overflow" | "off-canvas" | "low-contrast" | "remote-image" | "kit-drift" | "kit-exception";
  message: string;
}
export function designWarnings(document: DesignDocument): DesignWarning[];
export function designDiagnostics(document: DesignDocument): {
  warnings: DesignWarning[];
  contrastChecks: Array<{ id: string; status: "checked" | "unsupported"; ratio?: number; reason?: string }>;
};
/** At most 20 warning lines plus "…and N more", or "" when there are none. */
export function designWarningText(warnings: DesignWarning[]): string;
export function designColor(document: DesignDocument, value?: string, fallback?: string): string;
/** A color field or token value as one CSS color in a mode, or null. */
export function resolveDesignColor(tokens: Record<string, DesignColorToken> | undefined, value: DesignColorToken | undefined, mode?: DesignMode): string | null;
export function designColorReferences(value: DesignColorToken | undefined): string[];
/** The document with color tokens flattened to one mode, for previews and diagnostics. */
export function designDocumentForMode(document: DesignDocument, mode?: DesignMode): DesignDocument;
export function designFontFamily(value?: string, fontSize?: number): string;
/** CSS @font-face rules (data URIs) for the Inter, catalog and installed faces a document's visible text uses, or "". `localFonts: false` leaves installed faces out. */
export function designFontFaces(document: DesignDocument, options?: { localFonts?: boolean }): string;
export interface DesignLocalFamily {
  family: string;
  apple: boolean;
  wght?: { min: number; max: number };
  opsz?: { min: number; max: number; fixed?: number };
  weights: number[];
}
export interface DesignLocalFontSource {
  ready?: () => Promise<void>;
  family: (name: string) => DesignLocalFamily | null;
  load: (
    requests: Array<{ key: string; family: string; cssFamily: string; weight: number; opsz: number | null }>,
  ) => Promise<Array<{ key: string; data: string; advances: number[] } | null>>;
}
/** The host's installed fonts, for local previews only. */
export function setDesignLocalFonts(source: DesignLocalFontSource | null): void;
export function designLocalFamily(fontFamily?: string): DesignLocalFamily | null;
export function designAppleFamily(fontFamily: string): boolean;
export function designFontSubstitute(fontFamily: string): string | null;
export function designBundledFont(fontFamily?: string): Promise<{ family: string; weights: number[]; faces: Record<number, string> } | null>;
export const DESIGN_CATALOG_FAMILIES: string[];
export function designCatalogFont(fontFamily?: string): { family: string; weights: number[]; advances: Record<string, number[]> } | undefined;
export function loadDesignFonts(document: DesignDocument): Promise<void>;
/** TrueType data (base64) for a rasterizer: every Inter weight plus the loaded catalog faces the document uses. */
export function designFontBuffers(document: DesignDocument): string[];
export function designInterWeight(fontWeight?: number): 400 | 500 | 600 | 700;
export function designUsesInter(fontFamily?: string): boolean;
/** What a layer paints when it names no fill: frames and images that have a source stay transparent. */
export function designDefaultFill(node: Pick<DesignNode, "type" | "src">): string;
/** Whether the bundled Inter subset has a glyph for this character; whitespace always counts as drawable. */
export function designInterHasGlyph(character: string): boolean;
export function designHtml(document: DesignDocument): string;
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
export function designSvg(
  document: DesignDocument,
  options?: { embedFonts?: boolean; onCanvasOnly?: boolean; renderByteLimit?: number; mode?: DesignMode },
): string;
export function createExampleDesign(): DesignDocument;

export function designErrorIssues(error: unknown): Array<{ path: Array<string | number>; message: string }>;
export function conciseDesignError(error: unknown): Error;

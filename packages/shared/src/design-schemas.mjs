import { z } from "zod";
import { validDesignFontFamily } from "./design-font-family.mjs";
import { validDesignPath } from "./design-path.mjs";
import { designKitSchema, designBindingsSchema, designConsistencySchema, designColorSchema, designColorTokenSchema } from "./design-kit.mjs";
export { designKitDataSchema } from "./design-kit.mjs";

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/, "Use a stable layer id with letters, numbers, dots, underscores or dashes.");
const color = designColorSchema;
/** The smallest screen side, small enough for watch faces, complications and Dynamic Island pieces at 1x. */
export const DESIGN_MIN_SCREEN = 16;
const screen = z.number().int().min(DESIGN_MIN_SCREEN).max(3840);
const coordinate = z.number().finite().min(-32000).max(32000);
const dimension = z.number().finite().min(1).max(16000);
const size = z.number().finite().min(0).max(2000);

export const nodeSchema = z
  .object({
    id,
    name: z.string().max(160).optional(),
    type: z.enum(["frame", "text", "rectangle", "ellipse", "image", "icon", "path"]),
    parentId: id.optional(),
    x: coordinate.optional(),
    y: coordinate.optional(),
    width: dimension,
    height: dimension,
    widthMode: z
      .enum(["fixed", "hug", "fill"])
      .optional()
      .describe("Fixed uses width in pixels; hug fits content; fill uses available parent space. Defaults to fixed."),
    heightMode: z
      .enum(["fixed", "hug", "fill"])
      .optional()
      .describe("Fixed uses height in pixels; hug fits content; fill uses available parent space. Defaults to fixed."),
    minWidth: z.number().finite().min(0).max(16000).optional(),
    minHeight: z.number().finite().min(0).max(16000).optional(),
    fill: color.optional(),
    stroke: color.optional(),
    strokeWidth: size.optional(),
    radius: size.optional(),
    opacity: z.number().finite().min(0).max(1).optional(),
    text: z.string().max(20000).optional(),
    fontSize: z.number().finite().min(1).max(1000).optional(),
    fontFamily: z.string().max(160).refine(validDesignFontFamily, "Use non-empty font family names separated by commas.").optional(),
    fontWeight: z.number().int().min(100).max(900).optional(),
    lineHeight: z.number().finite().min(0.5).max(5).optional().describe("Unitless line-height multiplier, such as 1.35 or 1.5, never pixels. Default 1.35."),
    letterSpacing: z.number().finite().min(-100).max(100).optional().describe("Tracking in pixels added after each character; negative tightens."),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    src: z
      .string()
      .max(500000)
      .refine(
        (value) => /^https:\/\/[^\s<>"']+$/i.test(value) || /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-zA-Z0-9+/=]+$/.test(value),
        "Images need an HTTPS URL or an inline PNG, JPEG, WebP, GIF or AVIF.",
      )
      .optional(),
    icon: z
      .string()
      .max(64)
      .optional()
      .describe(
        "Lucide icon name for an icon layer, such as x, check, chevron-left or battery-full. fill is its line color, strokeWidth its line weight (default 2).",
      ),
    path: z
      .string()
      .max(20000)
      .refine(validDesignPath, "Use SVG path data only: commands and numbers, starting with M.")
      .optional()
      .describe("A path layer's SVG path data (d), in viewBox units: the layer's own pixels unless viewBox is set."),
    viewBox: z
      .tuple([coordinate, coordinate, z.number().finite().positive().max(16000), z.number().finite().positive().max(16000)])
      .optional()
      .describe("A path layer's coordinate box [minX, minY, width, height], scaled to fit the layer, such as [0, 0, 24, 24] for a glyph."),
    arc: z
      .object({
        start: z.number().finite().min(-360).max(360).optional(),
        sweep: z.number().finite().min(-360).max(360),
      })
      .strict()
      .optional()
      .describe(
        "Instead of path: a circular arc centred in the layer, start degrees clockwise from 12 o'clock for sweep degrees (360 is a full ring). Drawn as a stroke.",
      ),
    strokeCap: z.enum(["butt", "round", "square"]).optional(),
    strokeJoin: z.enum(["miter", "round", "bevel"]).optional(),
    strokeDash: z.array(z.number().finite().min(0).max(2000)).min(1).max(8).optional().describe("A path layer's dash pattern in pixels, such as [4, 2]."),
    layout: z.enum(["free", "horizontal", "vertical"]).optional(),
    gap: size.optional(),
    padding: size.optional(),
    align: z.enum(["start", "center", "end"]).optional(),
    justify: z.enum(["start", "center", "end", "space-between"]).optional(),
    hidden: z.boolean().optional(),
    locked: z.boolean().optional(),
    component: z.boolean().optional().describe("Mark a frame as a reusable main component. Nested components are not supported."),
    componentId: id.optional().describe("Link an instance frame to a main component id. Its children are generated and follow the main component."),
    textStyle: id.optional().describe("Text style name in the pinned design kit."),
    bindings: designBindingsSchema.optional().describe("Bind spacing fields and radius to named tokens in the pinned kit."),
    componentProperties: z
      .record(
        id,
        z
          .object({
            nodeId: id,
            field: z.enum(["text", "icon", "hidden", "fill", "opacity"]),
            options: z
              .array(z.union([z.string().max(20000), z.boolean(), z.number().finite()]))
              .min(1)
              .max(20)
              .optional(),
          })
          .strict(),
      )
      .optional()
      .describe("On a main component, expose named properties bound to a source layer field. options restricts allowed states."),
    componentValues: z
      .record(id, z.union([z.string().max(20000), z.boolean(), z.number().finite()]))
      .optional()
      .describe("On an instance, values for properties exposed by its main component, such as label or icon."),
    componentSourceId: id
      .optional()
      .describe("Generated reference from an instance descendant to its main layer. Edit the main component or detach the instance."),
  })
  .strict();

export const designDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    width: screen,
    height: screen,
    background: color.optional(),
    kit: designKitSchema.optional(),
    consistency: designConsistencySchema.optional(),
    tokens: z
      .record(id, designColorTokenSchema)
      .refine((value) => Object.keys(value).length <= 200, "Use at most 200 color tokens.")
      .optional(),
    nodes: z.array(nodeSchema).max(1000),
  })
  .strict();

const plainColor = z.string().max(400);
const { componentSourceId: _generated, ...wireNodeShape } = { ...nodeSchema.shape, fill: plainColor.optional(), stroke: plainColor.optional() };
export const designDocumentInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    width: screen,
    height: screen,
    background: plainColor.optional(),
    consistency: designConsistencySchema
      .optional()
      .describe(
        "Strict mode blocks saves with kit drift. Exceptions require nodeId, field, exact diagnostic actual value and a reason. Never disable strict mode or add exceptions unless the user intends that change.",
      ),
    kit: designKitSchema.optional().describe("Pinned project kit snapshot returned by design_kit_read. Read the project kit before creating screens."),
    tokens: z
      .record(z.string(), z.union([z.string(), z.object({ light: z.string(), dark: z.string().optional(), contrast: z.string().optional() })]))
      .optional()
      .describe(
        "Color tokens by name: one color, or {light, dark, contrast} for one design that switches modes. A color field takes a CSS color, $name, $name/0.4 for alpha, or color-mix(in srgb, $a 40%, $b).",
      ),
    nodes: z.array(z.looseObject(wireNodeShape)).max(1000),
  })
  .strict();
const documentPatchSchema = designDocumentSchema.omit({ nodes: true, schemaVersion: true }).partial();
const extraOperations = [
  z.object({ op: z.literal("document"), patch: documentPatchSchema }).strict(),
  z.object({ op: z.literal("detach"), id }).strict(),
  z.object({ op: z.literal("duplicate"), id, newId: id, x: coordinate.optional(), y: coordinate.optional() }).strict(),
  z
    .object({
      op: z.literal("unset"),
      id,
      fields: z
        .array(z.enum(["parentId", "textStyle", "bindings", "componentValues"]))
        .min(1)
        .max(4),
    })
    .strict(),
];
export const designOperationInputSchema = z.discriminatedUnion("op", [
  ...extraOperations,
  z.object({ op: z.literal("update"), id, patch: z.looseObject({}).describe("The layer fields to change: any design_show node field except id.") }).strict(),
  z
    .object({
      op: z.literal("insert"),
      node: z.looseObject({}).describe("The new layer, with the fields of a design_show node."),
      index: z.number().int().min(0).max(1000).optional(),
    })
    .strict(),
  z.object({ op: z.literal("delete"), id }).strict(),
]);

export const designOperationSchema = z.discriminatedUnion("op", [
  ...extraOperations,
  z.object({ op: z.literal("update"), id, patch: nodeSchema.omit({ id: true }).partial().strict() }).strict(),
  z.object({ op: z.literal("insert"), node: nodeSchema, index: z.number().int().min(0).max(1000).optional() }).strict(),
  z.object({ op: z.literal("delete"), id }).strict(),
  z.object({ op: z.literal("replace"), document: designDocumentSchema }).strict(),
]);

const ids = z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/)).max(100);
export const designEditIntentSchema = z
  .object({
    mode: z.enum(["text-only", "fit-text"]),
    textIds: ids.min(1),
    layoutIds: ids.optional(),
  })
  .strict()
  .describe(
    "text-only preserves all fields except text and all computed bounds. fit-text permits geometry within textIds and layoutIds subtrees, preserving styles and other copy. Layout must fit before saving. No automatic repair.",
  );

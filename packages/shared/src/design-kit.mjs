import { designError } from "./design-errors.mjs";
import { z } from "zod";
import { designPaint } from "./design-colors.mjs";
import { designDefaultFill } from "./design-paint.mjs";
import { designColorReferences, designColorSyntax, resolveDesignColor } from "./design-tokens.mjs";
import { DESIGN_DEFAULT_FONT_FAMILY, validDesignFontFamily } from "./design-font-family.mjs";

const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/);
/** A color field: a CSS color, `$token`, `$token/0.4` for alpha, or `color-mix(in srgb, $a 40%, $b)`. */
export const designColorSchema = z
  .string()
  .max(400)
  .refine(designColorSyntax, "Use a valid CSS color, a $token (with /0.4 for alpha) or color-mix(in srgb, A 40%, B).");
/** A color token: one color for every mode, or a color per mode (light required). */
export const designColorTokenSchema = z.union([
  designColorSchema,
  z.object({ light: designColorSchema, dark: designColorSchema.optional(), contrast: designColorSchema.optional() }).strict(),
]);
const color = designColorTokenSchema;
const map = (schema, max = 100) => z.record(key, schema).refine((value) => Object.keys(value).length <= max, `Use at most ${max} entries.`);
const textStyle = z
  .object({
    fontFamily: z.string().max(160).refine(validDesignFontFamily).optional(),
    fontSize: z.number().min(1).max(1000),
    fontWeight: z.number().int().min(100).max(900).optional(),
    lineHeight: z.number().min(0.5).max(5).optional(),
    letterSpacing: z.number().min(-100).max(100).optional(),
  })
  .strict();
export const designKitDataSchema = z
  .object({
    title: z.string().min(1).max(120),
    colors: map(color, 200),
    textStyles: map(textStyle),
    spacing: map(z.number().min(0).max(2000)),
    radii: map(z.number().min(0).max(2000)),
    tracking: map(z.number().min(-100).max(100)).optional(),
    opacity: map(z.number().min(0).max(1)).optional(),
    components: map(z.array(z.record(z.string(), z.unknown())).min(1).max(200), 30).optional(),
    references: z
      .array(z.object({ title: z.string().min(1).max(120), source: z.string().min(1).max(2000) }).strict())
      .max(20)
      .optional(),
  })
  .strict();
export const designKitSchema = designKitDataSchema.extend({ id: key, version: z.number().int().positive() });
export const designBindingsSchema = z
  .object({
    padding: key.optional(),
    gap: key.optional(),
    minWidth: key.optional(),
    minHeight: key.optional(),
    radius: key.optional(),
    letterSpacing: key.optional(),
    opacity: key.optional(),
  })
  .strict();
const bindingGroup = { radius: "radii", letterSpacing: "tracking", opacity: "opacity" };

export const designConsistencySchema = z
  .object({
    mode: z.enum(["advisory", "strict"]),
    exceptions: z
      .array(
        z
          .object({
            nodeId: z.string().min(1).max(100),
            field: z.string().min(1).max(110),
            value: z.union([z.string().max(1000), z.number().finite(), z.record(z.string(), z.union([z.string().max(1000), z.number().finite()]))]),
            reason: z.string().trim().min(8).max(500),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();

export function resolveDesignKit(document) {
  const kit = document.kit;
  for (const node of document.nodes) {
    if ((node.textStyle || Object.keys(node.bindings ?? {}).length) && !kit)
      throw designError(`Layer "${node.id}" needs a design kit for its style bindings.`, ["nodes", document.nodes.indexOf(node), "textStyle"]);
    if (node.textStyle) {
      if (node.type !== "text") throw Error(`Only text layers can use textStyle: "${node.id}".`);
      const style = kit.textStyles[node.textStyle];
      if (!Object.hasOwn(kit.textStyles, node.textStyle))
        throw designError(`Text style "${node.textStyle}" does not exist in kit "${kit.id}". Choose a name from kit.textStyles.`, [
          "nodes",
          document.nodes.indexOf(node),
          "textStyle",
        ]);
      for (const field of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"]) delete node[field];
      Object.assign(node, style);
    }
    for (const [field, token] of Object.entries(node.bindings ?? {})) {
      const group = kit[bindingGroup[field] ?? "spacing"] ?? {};
      const value = group[token];
      if (!Object.hasOwn(group, token))
        throw designError(`Kit token "${token}" for ${node.id}.${field} does not exist.`, ["nodes", document.nodes.indexOf(node), "bindings", field]);
      node[field] = value;
    }
  }
  if (kit) document.tokens = { ...kit.colors, ...document.tokens };
  return document;
}

const sameToken = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The document's color tokens on `nextKit`: its own tokens and deliberate overrides of `previousKit` kept, the colors it took from `previousKit` replaced. */
export function designKitTokens(tokens, previousKit, nextKit) {
  const own = Object.entries(tokens ?? {}).filter(
    ([name, value]) => !previousKit || !Object.hasOwn(previousKit.colors, name) || !sameToken(previousKit.colors[name], value),
  );
  return { ...nextKit.colors, ...Object.fromEntries(own) };
}

const colorKey = (value) => {
  if (typeof value !== "string") return null;
  const paint = designPaint(value);
  if (!paint) return null;
  const color =
    paint.color.length === 4 && paint.color.startsWith("#")
      ? "#" +
        paint.color
          .slice(1)
          .split("")
          .map((c) => c + c)
          .join("")
      : paint.color;
  return `${color.toLowerCase()}:${paint.opacity}`;
};

const typography = (node) => ({
  fontFamily: (node.fontFamily ?? DESIGN_DEFAULT_FONT_FAMILY)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .join(","),
  fontSize: node.fontSize ?? 16,
  fontWeight: node.fontWeight ?? 400,
  lineHeight: node.lineHeight ?? 1.35,
  letterSpacing: node.letterSpacing ?? 0,
});
const equalValue = (a, b) =>
  typeof a === "object" && a !== null && typeof b === "object" && b !== null
    ? Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => Object.hasOwn(b, k) && b[k] === v)
    : a === b;

export function designKitWarnings(document) {
  if (!document.kit) return [];
  const warnings = [];
  const kit = document.kit;
  const add = (nodeId, field, value, message) => {
    const exception = document.consistency?.exceptions?.find((e) => e.nodeId === nodeId && e.field === field && equalValue(e.value, value));
    const path = nodeId === "$document" ? field.split(".") : ["nodes", document.nodes.findIndex((n) => n.id === nodeId), field];
    warnings.push({
      id: nodeId,
      field,
      actual: value,
      path,
      kind: exception ? "kit-exception" : "kit-drift",
      message: exception ? `${message} Exception: ${exception.reason}` : message,
    });
  };
  const tokenKey = (tokens, name) => JSON.stringify(["light", "dark", "contrast"].map((mode) => colorKey(resolveDesignColor(tokens, `$${name}`, mode) ?? "")));
  for (const name of Object.keys(kit.colors))
    if (tokenKey({ ...kit.colors, ...document.tokens }, name) !== tokenKey(kit.colors, name))
      add("$document", `tokens.${name}`, document.tokens[name], `Color token "${name}" overrides kit ${kit.id} v${kit.version}. Restore the kit color.`);
  const styles = Object.values(kit.textStyles).map(typography);
  const palette = new Set(Object.keys(kit.colors).map((name) => colorKey(resolveDesignColor(kit.colors, `$${name}`))));
  const resolvedColor = (value) => (value === undefined ? undefined : (resolveDesignColor(document.tokens, value) ?? value));
  const outsidePalette = (value) => {
    const references = designColorReferences(value);
    if (references.length) return palette.size > 0 && !references.every((name) => Object.hasOwn(kit.colors, name));
    const resolved = resolvedColor(value);
    return palette.size && resolved && designPaint(resolved)?.color !== "none" && designPaint(resolved)?.opacity !== 0 && !palette.has(colorKey(resolved));
  };
  const background = document.background ?? "#ffffff";
  if (outsidePalette(background))
    add("$document", "background", resolvedColor(background), `Document background uses a color outside kit ${kit.id} v${kit.version}. Use a palette color.`);
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  for (const node of document.nodes) {
    let hidden = false;
    for (let ancestor = node; ancestor; ancestor = byId.get(ancestor.parentId))
      if (ancestor.hidden) {
        hidden = true;
        break;
      }
    if (hidden) continue;
    for (const field of ["fill", "stroke"]) {
      const value = node[field] ?? (field === "fill" ? designDefaultFill(node) : undefined);
      if (outsidePalette(value))
        add(node.id, field, resolvedColor(value), `${node.id}.${field} uses a color outside kit ${kit.id} v${kit.version}. Use a palette color.`);
    }
    for (const field of ["gap", "padding", "radius", "minWidth", "minHeight", "letterSpacing", "opacity"]) {
      if ((field === "minWidth" || field === "minHeight") && !node.bindings?.[field]) continue;
      if (field === "letterSpacing" && node.type === "text") continue;
      const values = Object.values(kit[bindingGroup[field] ?? "spacing"] ?? {});
      if (node[field] !== undefined && node[field] !== 0 && !(field === "opacity" && node[field] === 1) && values.length && !values.includes(node[field]))
        add(node.id, field, node[field], `${node.id}.${field} is outside kit ${kit.id} v${kit.version}. Bind an existing token.`);
    }
    if (node.type === "text" && styles.length && !styles.some((style) => equalValue(style, typography(node))))
      add(
        node.id,
        "typography",
        typography(node),
        `Text "${node.id}" does not match a text style from kit ${kit.id} v${kit.version}. Set textStyle to a kit style.`,
      );
  }
  return warnings;
}

export function validateDesignConsistency(document) {
  if (document.consistency?.mode !== "strict") return document;
  if (!document.kit) throw designError("Strict consistency requires a pinned project kit. Read design_kit_read and set document.kit.", ["kit"]);
  for (const field of ["colors", "textStyles", "spacing", "radii"])
    if (!Object.keys(document.kit[field]).length) throw designError(`Strict consistency requires at least one ${field} entry in the kit.`, ["kit", field]);
  const violations = designKitWarnings(document).filter((w) => w.kind === "kit-drift");
  if (violations.length) {
    const error = new Error(
      `Strict kit consistency: ${violations.length} violation(s). ${violations
        .slice(0, 5)
        .map((w) => w.message)
        .join(" ")}`,
    );
    error.code = "DESIGN_KIT_DRIFT";
    error.issues = violations.map((w) => ({ path: w.path, message: w.message }));
    throw error;
  }
  return document;
}

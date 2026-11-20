import { designPaint } from "./design-colors.mjs";
import { DESIGN_MODES } from "./design-modes.mjs";

const NAME = "[a-zA-Z][a-zA-Z0-9_.-]{0,95}";
const REFERENCE = new RegExp(`^\\$(${NAME})(?:\\s*\\/\\s*([0-9]*\\.?[0-9]+)(%?))?$`);
const MIX = /^color-mix\(\s*in\s+srgb\s*,([\s\S]*)\)$/i;
const MAX_DEPTH = 16;

function topLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

const channels = (css) => {
  const paint = designPaint(css);
  if (!paint) return null;
  if (paint.color === "none") return { rgb: [0, 0, 0], alpha: 0 };
  const hex = paint.color.slice(1);
  return { rgb: [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)), alpha: paint.opacity };
};

const css = ({ rgb, alpha }) => {
  const [r, g, b] = rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))));
  if (alpha >= 1) return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(Math.max(0, alpha) * 10000) / 10000})`;
};

function mix(first, second) {
  let [p1, p2] = [first.percent, second.percent];
  if (p1 === undefined && p2 === undefined) [p1, p2] = [50, 50];
  else if (p1 === undefined) p1 = 100 - p2;
  else if (p2 === undefined) p2 = 100 - p1;
  const sum = p1 + p2;
  if (!(sum > 0)) return null;
  const [w1, w2] = [p1 / sum, p2 / sum];
  const alpha = first.color.alpha * w1 + second.color.alpha * w2;
  const rgb = [0, 1, 2].map((i) => (alpha ? (first.color.rgb[i] * first.color.alpha * w1 + second.color.rgb[i] * second.color.alpha * w2) / alpha : 0));
  return { rgb, alpha: alpha * Math.min(1, sum / 100) };
}

/**
 * A color field or token value as one CSS color for a mode: a CSS color, `$token`, `$token/0.4` (alpha), or
 * `color-mix(in srgb, $a 40%, $b)`. A token is one color for every mode or `{light, dark?, contrast?}`; a mode it
 * leaves out uses light. Returns null for a missing token, a cycle or an unreadable color.
 */
export function resolveDesignColor(tokens, value, mode = "light", depth = 0) {
  if (depth > MAX_DEPTH || value === undefined || value === null) return null;
  if (typeof value === "object") return resolveDesignColor(tokens, value[mode] ?? value.light, mode, depth + 1);
  const source = String(value).trim();
  const reference = REFERENCE.exec(source);
  if (reference) {
    if (!tokens || !Object.hasOwn(tokens, reference[1])) return null;
    const base = resolveDesignColor(tokens, tokens[reference[1]], mode, depth + 1);
    if (base === null || reference[2] === undefined) return base;
    const color = channels(base);
    const factor = Number(reference[2]) / (reference[3] ? 100 : 1);
    return color && factor <= 1 ? css({ ...color, alpha: color.alpha * factor }) : null;
  }
  const mixed = MIX.exec(source);
  if (mixed) {
    const parts = topLevel(mixed[1]);
    if (parts.length !== 2) return null;
    const stops = parts.map((part) => {
      const match = /^([\s\S]*?)(?:\s+([0-9]*\.?[0-9]+)%)?$/.exec(part);
      const color = channels(resolveDesignColor(tokens, match[1], mode, depth + 1) ?? "");
      const percent = match[2] === undefined ? undefined : Number(match[2]);
      return color && (percent === undefined || percent <= 100) ? { color, percent } : null;
    });
    if (stops.includes(null)) return null;
    const result = mix(stops[0], stops[1]);
    return result ? css(result) : null;
  }
  return designPaint(source) ? source : null;
}

/** Token names a color field or token value refers to, directly. */
export function designColorReferences(value) {
  if (value && typeof value === "object") return [...new Set(Object.values(value).flatMap(designColorReferences))];
  return [...String(value ?? "").matchAll(new RegExp(`\\$(${NAME})`, "g"))].map((match) => match[1]);
}

/** Whether a string is shaped like a color field: a CSS color, a token reference with optional alpha, or a color-mix. */
export function designColorSyntax(value) {
  const source = String(value).trim();
  if (REFERENCE.test(source)) return true;
  if (MIX.test(source)) return topLevel(MIX.exec(source)[1]).length === 2;
  return designPaint(source) !== null;
}

/** Why a color can't be drawn in some mode, or null. */
export function designColorProblem(tokens, value) {
  for (const reference of designColorReferences(value))
    if (!tokens || !Object.hasOwn(tokens, reference)) return `Color token "$${reference}" does not exist. Add it to tokens or the pinned kit.`;
  for (const mode of DESIGN_MODES)
    if (resolveDesignColor(tokens, value, mode) === null)
      return `Color ${JSON.stringify(value)} can't be drawn in ${mode} mode: check its tokens for a cycle, an alpha above 1 or an invalid color.`;
  return null;
}

/** The document with every color token flattened to its value in one mode, for previews and diagnostics of that mode. */
export function designDocumentForMode(document, mode = "light") {
  if (!document.tokens && !document.kit) return document;
  const flatten = (tokens) =>
    tokens && Object.fromEntries(Object.keys(tokens).map((name) => [name, resolveDesignColor(tokens, tokens[name], mode) ?? "transparent"]));
  const tokens = document.tokens ?? {};
  return {
    ...document,
    ...(document.tokens ? { tokens: flatten(document.tokens) } : {}),
    ...(document.kit
      ? {
          kit: {
            ...document.kit,
            colors: Object.fromEntries(
              Object.keys(document.kit.colors).map((name) => [
                name,
                resolveDesignColor({ ...document.kit.colors, ...tokens }, `$${name}`, mode) ?? "transparent",
              ]),
            ),
          },
        }
      : {}),
  };
}

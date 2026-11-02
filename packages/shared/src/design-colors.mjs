import { namedColors } from "./design-color-names.mjs";

const clamp = (value, maximum = 1) => Math.max(0, Math.min(maximum, value));
const hex = (channels) => `#${channels.map((channel) => Math.round(clamp(channel, 255)).toString(16).padStart(2, "0")).join("")}`;
const alpha = (value) => clamp(value?.endsWith("%") ? parseFloat(value) / 100 : Number(value ?? 1));

// SVG 1.1 consumers do not all accept CSS's alpha hex, rgba or modern hsl syntax.
// Keep the paint and its alpha separate so shape, text and ancestor opacity compose correctly.
export function designPaint(value) {
  const source = value.trim();
  if (source.toLowerCase() === "transparent") return { color: "none", opacity: 1 };
  if (/^#[a-f0-9]{4}$/i.test(source)) {
    return {
      color: `#${source
        .slice(1, 4)
        .split("")
        .map((character) => character.repeat(2))
        .join("")}`,
      opacity: parseInt(source[4], 16) / 15,
    };
  }
  if (/^#[a-f0-9]{8}$/i.test(source)) return { color: source.slice(0, 7), opacity: parseInt(source.slice(7), 16) / 255 };
  const match = /^(rgba?|hsla?)\(([^)]+)\)$/i.exec(source);
  if (!match) {
    if (/^#[a-f0-9]{3,6}$/i.test(source) && [4, 7].includes(source.length)) return { color: source, opacity: 1 };
    const named = Object.hasOwn(namedColors, source.toLowerCase()) ? namedColors[source.toLowerCase()] : undefined;
    return named ? { color: hex(named), opacity: 1 } : null;
  }
  const number = "[-+]?(?:[0-9]*\\.[0-9]+|[0-9]+)(?:[eE][-+]?[0-9]+)?%?";
  const comma = new RegExp(`^${number}\\s*,\\s*${number}\\s*,\\s*${number}(?:\\s*,\\s*${number})?$`);
  const space = new RegExp(`^${number}\\s+${number}\\s+${number}(?:\\s*/\\s*${number})?$`);
  const content = match[2].trim();
  if (!(content.includes(",") ? comma : space).test(content)) return null;
  const parts = content.split(/[\s,/]+/);
  if (parts.some((part) => !Number.isFinite(Number(part.replace(/%$/, ""))))) return null;
  if (content.includes(",") && match[1].toLowerCase().startsWith("rgb") && !parts.slice(0, 3).every((part) => part.endsWith("%") === parts[0].endsWith("%")))
    return null;
  if (match[1].toLowerCase().startsWith("rgb")) {
    return { color: hex(parts.slice(0, 3).map((part) => (part.endsWith("%") ? parseFloat(part) * 2.55 : Number(part)))), opacity: alpha(parts[3]) };
  }
  if (parts[0].endsWith("%")) return null;
  if (!parts[1].endsWith("%") || !parts[2].endsWith("%")) return null;
  const hue = ((Number(parts[0]) % 360) + 360) % 360;
  const saturation = clamp(parseFloat(parts[1]) / 100);
  const lightness = clamp(parseFloat(parts[2]) / 100);
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const channels =
    hue < 60
      ? [chroma, second, 0]
      : hue < 120
        ? [second, chroma, 0]
        : hue < 180
          ? [0, chroma, second]
          : hue < 240
            ? [0, second, chroma]
            : hue < 300
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const offset = lightness - chroma / 2;
  return { color: hex(channels.map((channel) => (channel + offset) * 255)), opacity: alpha(parts[3]) };
}

export function designLuminance(value) {
  if (typeof value !== "string") return null;
  const paint = designPaint(value);
  if (!paint || paint.opacity !== 1 || paint.color === "none") return null;
  const raw = paint.color.slice(1);
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
  const [r, g, b] = full.match(/../g).map((c) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

import { designRenderBudget, visibleDesignTextLines } from "./design-render-limits.mjs";
import { designFontFamily, designInterWeight, designUsesInter } from "./design-fonts.mjs";
import { designIcons } from "./design-icons.mjs";

const xml = (value) =>
  String(value)
    // XML 1.0 excludes these controls and lone UTF-16 surrogates; valid surrogate pairs survive /u.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, "\ufffd")
    .replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
const number = (value) => String(Math.round(value * 10000) / 10000);
const clamp = (value, maximum = 1) => Math.max(0, Math.min(maximum, value));
const hex = (channels) => `#${channels.map((channel) => Math.round(clamp(channel, 255)).toString(16).padStart(2, "0")).join("")}`;
const alpha = (value) => clamp(value?.endsWith("%") ? parseFloat(value) / 100 : Number(value ?? 1));

// SVG 1.1 consumers do not all accept CSS's alpha hex, rgba or modern hsl syntax.
// Keep the paint and its alpha separate so shape, text and ancestor opacity compose correctly.
function paint(value) {
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
  if (!match) return { color: source, opacity: 1 };
  const parts = match[2].trim().split(/[\s,/]+/);
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => !Number.isFinite(Number(part.replace(/%$/, ""))))) {
    return { color: source, opacity: 1 };
  }
  if (match[1].toLowerCase().startsWith("rgb")) {
    return { color: hex(parts.slice(0, 3).map((part) => (part.endsWith("%") ? parseFloat(part) * 2.55 : Number(part)))), opacity: alpha(parts[3]) };
  }
  if (!parts[1].endsWith("%") || !parts[2].endsWith("%")) return { color: source, opacity: 1 };
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

function shape(node, box, inset = 0) {
  const width = Math.max(0, box.width - inset * 2);
  const height = Math.max(0, box.height - inset * 2);
  if (node.type === "ellipse") {
    return `ellipse cx="${number(box.x + box.width / 2)}" cy="${number(box.y + box.height / 2)}" rx="${number(width / 2)}" ry="${number(height / 2)}"`;
  }
  const radius = Math.max(0, Math.min(node.radius ?? 0, box.width / 2, box.height / 2) - inset);
  return `rect x="${number(box.x + inset)}" y="${number(box.y + inset)}" width="${number(width)}" height="${number(height)}" rx="${number(radius)}"`;
}

/**
 * Render a validated, expanded design without HTML, scripts, browser measurement or a DOM.
 * bounds: Map<nodeId, {x,y,width,height}> in absolute canvas coordinates.
 * textLayout(node, width): {lines: string[], width, height, lineHeight}, with lineHeight in pixels.
 * resolveColor(value, fallback): a token-resolved CSS color.
 * fontFaces: optional @font-face CSS the caller wants embedded in the SVG.
 * onCanvasOnly: leave out layers wholly outside the screen. Nothing of them is visible, and resvg panics on some of them
 * (an opacity or clip group far past the right or bottom edge), so the agent's rasterizer drops them.
 * HTTPS image references and font-family names remain references; this pure function does not fetch or embed them.
 */
export function renderDesignSvg(document, bounds, textLayout, resolveColor, fontFaces = "", { onCanvasOnly = false } = {}) {
  const children = new Map();
  for (const [index, node] of document.nodes.entries()) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push({ node, index });
    children.set(node.parentId, siblings);
  }
  const definitions = [];
  const take = designRenderBudget("SVG");
  const colorAttributes = (kind, value, fallback) => {
    const result = paint(resolveColor(value, fallback));
    if (result.opacity === 0) return `${kind}="none"`;
    return `${kind}="${xml(result.color)}"${result.opacity === 1 ? "" : ` ${kind}-opacity="${number(result.opacity)}"`}`;
  };
  const renderText = (node, box) => {
    const border = node.stroke ? (node.strokeWidth ?? 1) : 0;
    const contentWidth = Math.max(1, box.width - border * 2);
    const layout = textLayout(node, contentWidth);
    const fontSize = node.fontSize ?? 16;
    const lineHeight = layout.lineHeight;
    const anchor = node.textAlign === "center" ? "middle" : node.textAlign === "right" ? "end" : "start";
    const x = box.x + border + (anchor === "middle" ? contentWidth / 2 : anchor === "end" ? contentWidth : 0);
    const baseline = box.y + border + (lineHeight - fontSize) / 2 + fontSize * 0.8;
    // Inter text names the measured face it draws with. Browsers already pick that face through the @font-face weight ranges;
    // renderers that match by weight alone (resvg) would otherwise round 650 up to Bold, wider than the layout measured.
    const fontWeight = designUsesInter(node.fontFamily) ? designInterWeight(node.fontWeight) : (node.fontWeight ?? 400);
    const spans = visibleDesignTextLines(node, box, layout)
      .map((line, index) => take(`<tspan x="${number(x)}" y="${number(baseline + index * lineHeight)}">${xml(line)}</tspan>`, node))
      .join("");
    return (
      take(
        `<text ${colorAttributes("fill", node.fill, "#202720")} font-family="${xml(designFontFamily(node.fontFamily))}" font-size="${number(fontSize)}" font-weight="${fontWeight}" text-anchor="${anchor}" xml:space="preserve" style="font-kerning:none;font-variant-ligatures:none;font-feature-settings:&quot;calt&quot; 0">`,
        node,
      ) +
      spans +
      take("</text>", node)
    );
  };
  const renderChildren = (parentId) =>
    (children.get(parentId) ?? [])
      .map(({ node, index }) => {
        const box = bounds.get(node.id);
        if (node.hidden || !box) return "";
        if (onCanvasOnly && (box.x >= document.width || box.y >= document.height || box.x + box.width <= 0 || box.y + box.height <= 0)) return "";
        if (node.type === "icon") {
          const { color, opacity } = paint(resolveColor(node.fill, "#202720"));
          return take(
            `<g id="layer-${xml(node.id)}" opacity="${number((node.opacity ?? 1) * opacity)}"><title>${xml(node.name ?? node.id)}</title><svg x="${number(box.x)}" y="${number(box.y)}" width="${number(box.width)}" height="${number(box.height)}" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" stroke="${xml(color)}" stroke-width="${number(node.strokeWidth ?? 2)}" stroke-linecap="round" stroke-linejoin="round" color="${xml(color)}">${designIcons[node.icon]}</svg></g>`,
            node,
          );
        }
        const clip = `clip-${index}`;
        definitions.push(take(`<clipPath id="${clip}" clipPathUnits="userSpaceOnUse"><${shape(node, box)}/></clipPath>`, node));
        const strokeWidth = node.stroke ? Math.min(node.strokeWidth ?? 1, box.width, box.height) : 0;
        const stroke = strokeWidth > 0 ? ` ${colorAttributes("stroke", node.stroke, "transparent")} stroke-width="${number(strokeWidth)}"` : "";
        const geometry = shape(node, box, strokeWidth / 2);
        const hasContentClip = strokeWidth > 0 && ["frame", "text", "image"].includes(node.type);
        if (hasContentClip)
          definitions.push(take(`<clipPath id="${clip}-content" clipPathUnits="userSpaceOnUse"><${shape(node, box, strokeWidth)}/></clipPath>`, node));
        const clipContent = (content) => (hasContentClip ? take(`<g clip-path="url(#${clip}-content)">`, node) + content + take("</g>", node) : content);
        let contents;
        if (node.type === "text") {
          contents = clipContent(renderText(node, box));
          if (stroke) contents += take(`<${geometry} fill="none"${stroke}/>`, node);
        } else if (node.type === "image") {
          // Only a missing image gets the placeholder; a transparent one shows what is behind it.
          contents = node.fill || !node.src ? take(`<${shape(node, box)} ${colorAttributes("fill", node.fill, "#d8ded8")}/>`, node) : "";
          if (node.src)
            contents += clipContent(
              take(
                `<image x="${number(box.x + strokeWidth)}" y="${number(box.y + strokeWidth)}" width="${number(Math.max(0, box.width - 2 * strokeWidth))}" height="${number(Math.max(0, box.height - 2 * strokeWidth))}" href="${xml(node.src)}" xlink:href="${xml(node.src)}" preserveAspectRatio="xMidYMid slice"/>`,
                node,
              ),
            );
          if (stroke) contents += take(`<${geometry} fill="none"${stroke}/>`, node);
        } else {
          contents = take(`<${shape(node, box)} ${colorAttributes("fill", node.fill, node.type === "frame" ? "transparent" : "#d8ded8")}/>`, node);
          if (stroke) contents += take(`<${geometry} fill="none"${stroke}/>`, node);
        }
        if (node.type === "frame") contents += clipContent(renderChildren(node.id));
        return (
          take(
            `<g id="layer-${xml(node.id)}" opacity="${number(node.opacity ?? 1)}" clip-path="url(#${clip})"><title>${xml(node.name ?? node.id)}</title>`,
            node,
          ) +
          contents +
          take("</g>", node)
        );
      })
      .join("");
  const body = renderChildren(undefined);
  return (
    take(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${document.width}" height="${document.height}" viewBox="0 0 ${document.width} ${document.height}" overflow="hidden">`,
    ) +
    (definitions.length || fontFaces ? take("<defs>") + (fontFaces ? take(`<style>${fontFaces}</style>`) : "") + definitions.join("") + take("</defs>") : "") +
    take(`<rect x="0" y="0" width="${document.width}" height="${document.height}" ${colorAttributes("fill", document.background, "#ffffff")}/>`) +
    body +
    take("</svg>")
  );
}

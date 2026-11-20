import { designPaint } from "./design-colors.mjs";
import { designRenderBudget, visibleDesignTextLines } from "./design-render-limits.mjs";
import { designDrawnWeight, designFontFamily } from "./design-fonts.mjs";
import { designLucideIcon, designSymbolImage } from "./design-symbols.mjs";
import { DESIGN_INK, designDefaultFill } from "./design-paint.mjs";
import { designPathGeometry, designPathStroked, designPathStrokeShape } from "./design-path.mjs";

const xml = (value) =>
  String(value)
    // oxlint-disable-next-line no-control-regex -- XML 1.0 excludes these controls and lone surrogates; valid pairs survive /u.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, "\ufffd")
    .replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
const number = (value) => String(Math.round(value * 10000) / 10000);
const paint = (value) => designPaint(value) ?? { color: "none", opacity: 1 };

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
 * bounds: Map<nodeId, {x,y,width,height}> in absolute canvas coordinates.
 * textLayout(node, width): {lines: string[], width, height, lineHeight}, with lineHeight in pixels.
 * resolveColor(value, fallback): a token-resolved CSS color.
 * fontFaces: optional @font-face CSS the caller wants embedded in the SVG.
 * onCanvasOnly: leave out layers wholly outside the screen. Nothing of them is visible, and resvg panics on some of them
 * (an opacity or clip group far past the right or bottom edge), so the agent's rasterizer drops them.
 * HTTPS image references and font-family names remain references; this pure function does not fetch or embed them.
 */
export function renderDesignSvg(document, bounds, textLayout, resolveColor, fontFaces = "", { onCanvasOnly = false, renderByteLimit } = {}) {
  const children = new Map();
  for (const [index, node] of document.nodes.entries()) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push({ node, index });
    children.set(node.parentId, siblings);
  }
  const definitions = [];
  const take = designRenderBudget("SVG", renderByteLimit);
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
    // Renderers that match by weight alone (resvg) would round 650 up to Bold, wider than the layout measured.
    const fontWeight = designDrawnWeight(node.fontFamily, node.fontWeight, fontSize);
    const spans = visibleDesignTextLines(node, box, layout)
      .map((line, index) => take(`<tspan x="${number(x)}" y="${number(baseline + index * lineHeight)}">${xml(line)}</tspan>`, node))
      .join("");
    return (
      take(
        `<text ${colorAttributes("fill", node.fill, designDefaultFill(node))} font-family="${xml(designFontFamily(node.fontFamily, fontSize))}" font-size="${number(fontSize)}" font-weight="${fontWeight}"${node.letterSpacing ? ` letter-spacing="${number(node.letterSpacing)}"` : ""} text-anchor="${anchor}" xml:space="preserve" style="font-kerning:none;font-variant-ligatures:none;font-feature-settings:&quot;calt&quot; 0">`,
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
        if (node.type === "path") {
          const geometry = designPathGeometry(node, box);
          const strokeColor = node.stroke ?? (geometry.arc ? node.fill : undefined);
          const stroke = designPathStroked(node) ? ` ${colorAttributes("stroke", strokeColor, DESIGN_INK)} ${designPathStrokeShape(node, geometry)}` : "";
          const fill = geometry.arc ? 'fill="none"' : colorAttributes("fill", node.fill, designDefaultFill(node));
          return take(
            `<g id="layer-${xml(node.id)}" opacity="${number(node.opacity ?? 1)}"><title>${xml(node.name ?? node.id)}</title><svg x="${number(box.x)}" y="${number(box.y)}" width="${number(box.width)}" height="${number(box.height)}" viewBox="${geometry.viewBox}" preserveAspectRatio="xMidYMid meet" overflow="hidden"><path d="${xml(geometry.d)}" ${fill}${stroke}/></svg></g>`,
            node,
          );
        }
        if (node.type === "icon") {
          const { color, opacity } = paint(resolveColor(node.fill, designDefaultFill(node)));
          const head = `<g id="layer-${xml(node.id)}" opacity="${number((node.opacity ?? 1) * opacity)}"><title>${xml(node.name ?? node.id)}</title>`;
          const frame = `x="${number(box.x)}" y="${number(box.y)}" width="${number(box.width)}" height="${number(box.height)}"`;
          const symbol = designSymbolImage(node);
          if (symbol) {
            const source = `data:image/png;base64,${symbol.png}`;
            definitions.push(
              take(
                `<mask id="symbol-${index}" maskUnits="userSpaceOnUse" ${frame}><image ${frame} preserveAspectRatio="xMidYMid meet" href="${source}" xlink:href="${source}"/></mask>`,
                node,
              ),
            );
            return take(`${head}<rect ${frame} fill="${xml(color)}" mask="url(#symbol-${index})"/></g>`, node);
          }
          const lucide = designLucideIcon(node);
          return take(
            `${head}<svg ${frame} viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="${lucide.filled ? xml(color) : "none"}" stroke="${xml(color)}" stroke-width="${number(lucide.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" color="${xml(color)}">${lucide.markup}</svg></g>`,
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
          contents = node.fill || !node.src ? take(`<${shape(node, box)} ${colorAttributes("fill", node.fill, designDefaultFill(node))}/>`, node) : "";
          if (node.src)
            contents += clipContent(
              take(
                `<image x="${number(box.x + strokeWidth)}" y="${number(box.y + strokeWidth)}" width="${number(Math.max(0, box.width - 2 * strokeWidth))}" height="${number(Math.max(0, box.height - 2 * strokeWidth))}" href="${xml(node.src)}" xlink:href="${xml(node.src)}" preserveAspectRatio="xMidYMid slice"/>`,
                node,
              ),
            );
          if (stroke) contents += take(`<${geometry} fill="none"${stroke}/>`, node);
        } else {
          contents = take(`<${shape(node, box)} ${colorAttributes("fill", node.fill, designDefaultFill(node))}/>`, node);
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

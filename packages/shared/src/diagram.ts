// Mermaid diagrams in replies, drawn by Pele (pele.run). Pele's SVG colours itself from --pele-* custom properties;
// where nothing evaluates CSS (React Native's SVG, an <img> of the SVG), the colours are written into it instead.

/** Whether a fenced block is a Mermaid diagram. */
export const isMermaidFence = (fence: string | undefined | null) => (fence ?? "").trim().toLowerCase() === "mermaid";

const LABELS: Record<string, string> = {
  flowchart: "Flowchart",
  graph: "Flowchart",
  sequence: "Sequence diagram",
  class: "Class diagram",
  classDiagram: "Class diagram",
  state: "State diagram",
  stateDiagram: "State diagram",
  er: "Entity relationship diagram",
  erDiagram: "Entity relationship diagram",
  gantt: "Gantt chart",
  pie: "Pie chart",
  mindmap: "Mind map",
  timeline: "Timeline",
  gitGraph: "Git graph",
  journey: "User journey",
  quadrantChart: "Quadrant chart",
  xychart: "Chart",
  sankey: "Sankey diagram",
  block: "Block diagram",
  packet: "Packet diagram",
  architecture: "Architecture diagram",
  kanban: "Kanban board",
  radar: "Radar chart",
  treemap: "Treemap",
  requirement: "Requirement diagram",
  c4: "C4 diagram",
  zenuml: "Sequence diagram",
};

/** What a diagram is, in words, from the type Pele detects (detectType); "Diagram" for one it doesn't know. */
export function diagramLabel(type: string | null | undefined): string {
  if (!type) return "Diagram";
  return LABELS[type] ?? LABELS[type.replace(/-?(?:v\d+|beta)$/i, "")] ?? "Diagram";
}

/** Pele's colour and font properties, by name (`--pele-bg`, `--pele-fg`, ...). */
export type DiagramTheme = Record<string, string>;

/**
 * The theme for a diagram on `background` in `ink`: Pele's surfaces and borders as mixes of the two, so it reads on
 * light and dark alike. `accent` marks highlights. Plain colours (hex or rgb), since React Native can't mix.
 */
export function diagramTheme({
  background,
  ink,
  muted,
  line,
  accent,
}: {
  background: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
}): DiagramTheme {
  return {
    "--pele-bg": background,
    "--pele-fg": ink,
    "--pele-muted": muted,
    "--pele-line": ink,
    "--pele-surface": mix(ink, background, 0.07),
    "--pele-surface-alt": mix(ink, background, 0.12),
    "--pele-border": line,
    "--pele-accent": accent,
  };
}

/** `a` over `b` at `amount`, for two hex colours; `b` when either isn't one. */
function mix(a: string, b: string, amount: number): string {
  const from = hex(a),
    to = hex(b);
  if (!from || !to) return b;
  return `#${from
    .map((channel, index) => Math.round(channel * amount + to[index]! * (1 - amount)))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function hex(color: string): number[] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(color.trim());
  if (!match) return null;
  const digits = match[1]!.length === 3 ? [...match[1]!].map((digit) => digit + digit).join("") : match[1]!;
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
}

const VARIABLE = /var\((--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;

/**
 * Pele's SVG with every var() written out: the theme's values first, then the diagram's own (its root declares
 * `--_bg: var(--pele-bg, #fff)` and so on), then each fallback. For an <img> of the SVG, which sees no outside CSS.
 */
export function resolveDiagramSvg(svg: string, theme: DiagramTheme = {}): string {
  const rootStyle = /^\s*<svg\b[^>]*?\sstyle="([^"]*)"/.exec(svg)?.[1] ?? "";
  const own = new Map<string, string>();
  for (const declaration of rootStyle.split(";")) {
    const colon = declaration.indexOf(":");
    const name = declaration.slice(0, colon).trim();
    if (colon > 0 && name.startsWith("--")) own.set(name, declaration.slice(colon + 1).trim());
  }
  const resolve = (text: string, depth = 0): string =>
    text.replace(VARIABLE, (_match, name: string, fallback: string | undefined) => {
      if (depth > 8) return fallback?.trim() ?? "";
      const value = theme[name] ?? own.get(name);
      if (value !== undefined) return resolve(value, depth + 1);
      return fallback === undefined ? "" : resolve(fallback.trim(), depth + 1);
    });
  return resolve(svg);
}

/** Presentation properties Pele sets in style attributes, which React Native's SVG reads only as attributes. */
const PRESENTATION = new Set(["fill", "stroke", "rx", "ry", "opacity", "font-weight", "font-size", "font-style", "stroke-width", "stroke-dasharray"]);

/**
 * Pele's SVG for React Native's SVG renderer: colours written out (resolveDiagramSvg), style properties moved into
 * attributes, and what it can't draw or doesn't need dropped (links, titles, classes, ARIA, data attributes). The root
 * keeps its size and gets its font size and colour as attributes; its font is the device's unless the theme names one.
 */
export function nativeDiagramSvg(svg: string, theme: DiagramTheme = {}): string {
  const resolved = resolveDiagramSvg(svg, theme);
  return (
    resolved
      .replace(/^(\s*<svg\b[^>]*?)\sstyle="([^"]*)"/, (_match, head: string, style: string) => {
        const font = /(?:^|;)\s*font:\s*([\d.]+)px/.exec(style)?.[1];
        const color = /(?:^|;)\s*color:\s*([^;]+)/.exec(style)?.[1]?.trim();
        const family = theme["--pele-font"];
        return `${head}${font ? ` font-size="${font}"` : ""}${color ? ` color="${color}"` : ""}${family ? ` font-family="${family.replace(/"/g, "'")}"` : ""}`;
      })
      // A style property outranks the attribute of the same name, as in CSS: it replaces it.
      .replace(/<(\w+)([^>]*?)\sstyle="([^"]*)"/g, (_match, tag: string, attributes: string, style: string) => {
        let kept = attributes;
        const moved = style
          .split(";")
          .map((declaration) => declaration.split(":").map((part) => part.trim()))
          .filter(([name, value]) => name && value && PRESENTATION.has(name))
          .map(([name, value]) => {
            kept = kept.replace(new RegExp(`\\s${name}="[^"]*"`), "");
            return ` ${name}="${(name === "rx" || name === "ry" || name === "font-size" ? value!.replace(/px$/, "") : value!).replace(/"/g, "'")}"`;
          })
          .join("");
        return `<${tag}${kept}${moved}`;
      })
      .replace(/<title>[\s\S]*?<\/title>/g, "")
      .replace(/<a\b[^>]*>|<\/a>/g, "")
      .replace(/\s(?:class|role|aria-[\w-]+|data-[\w-]+)="[^"]*"/g, "")
  );
}

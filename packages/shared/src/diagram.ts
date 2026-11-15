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

export function diagramLabel(type: string | null | undefined): string {
  if (!type) return "Diagram";
  return LABELS[type] ?? LABELS[type.replace(/-?(?:v\d+|beta)$/i, "")] ?? "Diagram";
}

export type DiagramTheme = Record<string, string>;

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

const PRESENTATION = new Set(["fill", "stroke", "rx", "ry", "opacity", "font-weight", "font-size", "font-style", "stroke-width", "stroke-dasharray"]);

export function nativeDiagramSvg(svg: string, theme: DiagramTheme = {}): string {
  const resolved = resolveDiagramSvg(svg, theme);
  return resolved
    .replace(/^(\s*<svg\b[^>]*?)\sstyle="([^"]*)"/, (_match, head: string, style: string) => {
      const font = /(?:^|;)\s*font:\s*([\d.]+)px/.exec(style)?.[1];
      const color = /(?:^|;)\s*color:\s*([^;]+)/.exec(style)?.[1]?.trim();
      const family = theme["--pele-font"];
      return `${head}${font ? ` font-size="${font}"` : ""}${color ? ` color="${color}"` : ""}${family ? ` font-family="${family.replace(/"/g, "'")}"` : ""}`;
    })
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
    .replace(/\s(?:class|role|aria-[\w-]+|data-[\w-]+)="[^"]*"/g, "");
}

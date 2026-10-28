import type { Subagent } from "./model.ts";

/**
 * One shape of a persona's face, in SVG terms on a -50..50 viewBox: its element name and its attributes, named as
 * React (react-dom and react-native-svg) takes them.
 */
export type BloubShape = { type: "rect" | "circle" | "ellipse" | "polygon"; props: Record<string, string | number> };

/** A QA fleet persona (the qa-fleet skill's agent types): how desktop and phone draw its subagent. */
export interface QaPersona {
  /** Its agent type, as Claude's subagent_type names it. */
  type: string;
  name: string;
  /** Who it plays, for its detail card. */
  title: string;
  tagline: string;
  /** Its face: a solid blob with white eyes, the same in light and dark. */
  face: BloubShape[];
  /** The tag and card fill and their ink, a pale shade of the face's colour. */
  tint: string;
  ink: string;
  /** The conditions it tests under, when it sets any. */
  chips?: string[];
}

const EYE = "#ffffff";
const rect = (x: number, y: number, width: number, height: number, rx: number, fill: string, transform?: string): BloubShape => ({
  type: "rect",
  props: { x, y, width, height, rx, fill, ...(transform ? { transform } : {}) },
});
const circle = (cx: number, cy: number, r: number, fill: string): BloubShape => ({ type: "circle", props: { cx, cy, r, fill } });
const polygon = (points: string, fill: string, strokeWidth: number): BloubShape => ({
  type: "polygon",
  props: { points, fill, stroke: fill, strokeWidth, strokeLinejoin: "round" },
});

export const QA_PERSONAS: readonly QaPersona[] = [
  {
    type: "qa-impatient",
    name: "Impatient",
    title: "The impatient one",
    tagline: "Skims, clicks the first button, quits at the first error",
    // An orange rounded square with annoyed, slanted eyes.
    face: [rect(-40, -36, 80, 72, 24, "#f2892b"), rect(-24, -2, 15, 6, 3, EYE, "rotate(14 -16.5 1)"), rect(9, -2, 15, 6, 3, EYE, "rotate(-14 16.5 1)")],
    tint: "#f6dcc3",
    ink: "#8a4b14",
  },
  {
    type: "qa-skeptic",
    name: "Skeptic",
    title: "The skeptic",
    tagline: "Reads pricing, terms and privacy before signing up",
    // A purple cloud: one eye open, the other squinting under a raised brow.
    face: [
      ...[
        [-18, -6, 24],
        [14, -14, 22],
        [26, 10, 21],
        [-24, 16, 20],
        [2, 16, 25],
      ].map(([cx, cy, r]) => circle(cx!, cy!, r!, "#8b5cf6")),
      { type: "ellipse", props: { cx: -11, cy: 4, rx: 5.5, ry: 8.5, fill: EYE } },
      rect(7, 3, 14, 5, 2.5, EYE),
      rect(6, -11, 16, 4.5, 2.25, EYE, "rotate(-12 14 -9)"),
    ],
    tint: "#e1d8f5",
    ink: "#4b3a7a",
  },
  {
    type: "qa-mobile",
    name: "Mobile",
    title: "The mobile user",
    tagline: "Does everything on a small phone over slow 3G",
    // A blue phone-shaped pill with a notch and two dot eyes.
    face: [rect(-27, -44, 54, 88, 20, "#3b82f6"), rect(-7, -36, 14, 4, 2, "#a9c8fb"), circle(-10, -4, 5.5, EYE), circle(10, -4, 5.5, EYE)],
    tint: "#d3e4fc",
    ink: "#1f4f8a",
    chips: ["375 × 812", "Slow 3G", "Touch"],
  },
  {
    type: "qa-literal",
    name: "Literal",
    title: "The non-native English speaker",
    tagline: "Follows only what the UI literally says",
    // A green pebble with wide eyes looking up, reading every word.
    face: [
      { type: "ellipse", props: { cx: 0, cy: 2, rx: 44, ry: 37, fill: "#22b573" } },
      circle(-14, 0, 10, EYE),
      circle(14, 0, 10, EYE),
      circle(-12, -4, 4.5, "#0f5c39"),
      circle(16, -4, 4.5, "#0f5c39"),
    ],
    tint: "#cfe9dd",
    ink: "#1f5c44",
  },
  {
    type: "qa-breaker",
    name: "Breaker",
    title: "The breaker",
    tagline: "Pastes junk, hits Back mid-flow, double-clicks everything",
    // A red spiky blob with angry eyes.
    face: [
      polygon("0,-44 12,-30 30,-36 30,-18 44,-8 34,6 42,22 24,26 18,42 2,34 -14,42 -20,26 -38,24 -32,8 -44,-4 -30,-16 -32,-34 -14,-30", "#ef4444", 10),
      polygon("-22,-6 -6,0 -7,6 -21,4", EYE, 3),
      polygon("22,-6 6,0 7,6 21,4", EYE, 3),
    ],
    tint: "#f6d0d0",
    ink: "#8a2323",
  },
];

/**
 * The persona a subagent plays: by its agent type, or for a provider without agent types (Codex) by a "QA <Name>" title,
 * as the qa-fleet skill asks.
 */
export function qaPersona(agent: Pick<Subagent, "agentType" | "title">): QaPersona | undefined {
  const title = agent.title.toLowerCase();
  return QA_PERSONAS.find((persona) => persona.type === agent.agentType) ?? QA_PERSONAS.find((persona) => title.startsWith(`qa ${persona.name.toLowerCase()}`));
}

/** The panel's order: the QA fleet first, as one group, then every other subagent, each in its own order. */
export function qaFleetFirst<T extends Pick<Subagent, "agentType" | "title">>(agents: readonly T[]): { fleet: T[]; others: T[] } {
  return { fleet: agents.filter((agent) => qaPersona(agent)), others: agents.filter((agent) => !qaPersona(agent)) };
}

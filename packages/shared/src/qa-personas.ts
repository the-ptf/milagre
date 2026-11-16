import type { Subagent } from "./model.ts";

/** An Open Bot Avatar definition (v1): one body path in a 0..100 box and where its eyes sit. */
export type AvatarDefinition = {
  version: 1;
  id: string;
  name: string;
  body: { path: string };
  eyes: { x: number; y: number; spacing: number; scale: number };
};

export interface QaPersona {
  type: string;
  name: string;
  title: string;
  tagline: string;
  avatar: AvatarDefinition;
  /** The avatar's body color. */
  color: string;
  tint: string;
  ink: string;
  chips?: string[];
}

const avatar = (id: string, name: string, path: string, eyes: AvatarDefinition["eyes"]): AvatarDefinition => ({ version: 1, id, name, body: { path }, eyes });

export const QA_PERSONAS: readonly QaPersona[] = [
  {
    type: "qa-impatient",
    name: "Impatient",
    title: "The impatient one",
    tagline: "Skims, clicks the first button, quits at the first error",
    avatar: avatar("impatient", "Impatient", "M34 16H66C78 16 86 24 86 36V64C86 76 78 84 66 84H34C22 84 14 76 14 64V36C14 24 22 16 34 16Z", {
      x: 50,
      y: 48,
      spacing: 18,
      scale: 1.15,
    }),
    color: "#f2892b",
    tint: "#f6dcc3",
    ink: "#8a4b14",
  },
  {
    type: "qa-skeptic",
    name: "Skeptic",
    title: "The skeptic",
    tagline: "Reads pricing, terms and privacy before signing up",
    avatar: avatar("skeptic", "Skeptic", "M24 78C14 78 9 71 9 63C9 54 15 48 23 47.5C25 35 36 26 49 26C61 26 70 33 73 43C83 43 91 51 91 61C91 71 83 78 74 78Z", {
      x: 50,
      y: 56,
      spacing: 17,
      scale: 1.15,
    }),
    color: "#8b5cf6",
    tint: "#e1d8f5",
    ink: "#4b3a7a",
  },
  {
    type: "qa-mobile",
    name: "Mobile",
    title: "The mobile user",
    tagline: "Does everything on a small phone over slow 3G",
    avatar: avatar("mobile", "Mobile", "M42 10H58C67 10 72 15 72 24V76C72 85 67 90 58 90H42C33 90 28 85 28 76V24C28 15 33 10 42 10Z", {
      x: 50,
      y: 46,
      spacing: 15,
      scale: 1.05,
    }),
    color: "#3b82f6",
    tint: "#d3e4fc",
    ink: "#1f4f8a",
    chips: ["375 × 812", "Slow 3G", "Touch"],
  },
  {
    type: "qa-literal",
    name: "Literal",
    title: "The non-native English speaker",
    tagline: "Follows only what the UI literally says",
    avatar: avatar("literal", "Literal", "M50 20C72 20 90 33 90 51C90 69 72 82 50 82C28 82 10 69 10 51C10 33 28 20 50 20Z", {
      x: 50,
      y: 50,
      spacing: 19,
      scale: 1.25,
    }),
    color: "#22b573",
    tint: "#cfe9dd",
    ink: "#1f5c44",
  },
  {
    type: "qa-breaker",
    name: "Breaker",
    title: "The breaker",
    tagline: "Pastes junk, hits Back mid-flow, double-clicks everything",
    avatar: avatar("breaker", "Breaker", "M50 10L59 25L76 18L75 36L91 42L79 55L88 70L70 72L66 89L50 80L34 89L30 72L12 70L21 55L9 42L25 36L24 18L41 25Z", {
      x: 50,
      y: 50,
      spacing: 17,
      scale: 1.1,
    }),
    color: "#ef4444",
    tint: "#f6d0d0",
    ink: "#8a2323",
  },
];

/** How a persona's avatar moves for its subagent: thinking while it works, happy once it's done, still otherwise. */
export function qaPersonaMood(agent: Pick<Subagent, "status">): "idle" | "thinking" | "happy" {
  if (agent.status === "running" || agent.status === "initializing" || agent.status === "waiting") return "thinking";
  return agent.status === "completed" ? "happy" : "idle";
}

/**
 * The persona a subagent plays: by agent type, or for a provider without agent types (Codex) by a "QA <Name>" title.
 */
export function qaPersona(agent: Pick<Subagent, "agentType" | "title">): QaPersona | undefined {
  const title = agent.title.toLowerCase();
  return QA_PERSONAS.find((persona) => persona.type === agent.agentType) ?? QA_PERSONAS.find((persona) => title.startsWith(`qa ${persona.name.toLowerCase()}`));
}

/** The panel's order: the QA fleet first, as one group, then every other subagent, each in its own order. */
export function qaFleetFirst<T extends Pick<Subagent, "agentType" | "title">>(agents: readonly T[]): { fleet: T[]; others: T[] } {
  return { fleet: agents.filter((agent) => qaPersona(agent)), others: agents.filter((agent) => !qaPersona(agent)) };
}

/**
 * The fleet a Chat is running now: for each persona, its latest launch that isn't archived, in the personas' order. A rerun
 * replaces the earlier launch of the same persona, so a launch a hook refused doesn't stay beside the one that ran.
 */
export function qaFleetRoster<T extends Pick<Subagent, "agentType" | "title" | "startedAt" | "archived">>(
  agents: readonly T[],
): { persona: QaPersona; agent: T }[] {
  return QA_PERSONAS.flatMap((persona) => {
    const latest = agents
      .filter((agent) => !agent.archived && qaPersona(agent) === persona)
      .reduce<T | undefined>((last, agent) => (!last || agent.startedAt >= last.startedAt ? agent : last), undefined);
    return latest ? [{ persona, agent: latest }] : [];
  });
}

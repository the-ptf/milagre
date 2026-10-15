import type { Subagent, SubagentCommunication } from "@milagre/shared/model";

export const MAIN_AGENT = "__main_agent__";
export type Point = { x: number; y: number };
export type Viewport = Point & { scale: number };
export const agentNodeId = (id: string | null) => id ?? MAIN_AGENT;
export const COMMUNICATION_TTL_MS = 12_000;

// Ellipses leave room below each body for its name/status without widening horizontal pushes.
const COLLISION_STRETCH = 1.35;
const COLLISION_GAP = 0.001;
const collisionRadius = (id: string) => (id === MAIN_AGENT ? 56 : 48);
const collisionOffset = (id: string) => (id === MAIN_AGENT ? 16 : 10);
const collisionCenter = (id: string, point: Point): Point => ({ x: point.x, y: (point.y + collisionOffset(id)) / COLLISION_STRETCH });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const direction = (x: number, y: number, fallback: Point): Point => {
  const length = Math.hypot(x, y);
  return length > 0.000001 ? { x: x / length, y: y / length } : fallback;
};

// Distances along a ray that lie inside a circle. Sorting these intervals lets a push
// clear a chain in one finite pass instead of iterating a physics solver until it settles.
function collisionInterval(origin: Point, unit: Point, obstacle: Point, radius: number): [number, number] | null {
  const x = obstacle.x - origin.x;
  const y = obstacle.y - origin.y;
  const along = x * unit.x + y * unit.y;
  const across = x * unit.y - y * unit.x;
  const squaredReach = radius * radius - across * across;
  if (squaredReach <= 0) return null;
  const reach = Math.sqrt(squaredReach);
  return [along - reach, along + reach];
}

/** Keep the dragged anchor exact, pushing only bots that collide along its world-space path. */
export function moveAgentWithCollisions(points: Record<string, Point>, movedId: string, target: Point): Record<string, Point> {
  const source = points[movedId] ?? target;
  const start = collisionCenter(movedId, source);
  const end = collisionCenter(movedId, target);
  const motion = direction(end.x - start.x, end.y - start.y, { x: 1, y: 0 });
  const others = Object.keys(points)
    .filter((id) => id !== movedId)
    .sort();
  const centers: Record<string, Point> = Object.fromEntries(Object.entries(points).map(([id, point]) => [id, collisionCenter(id, point)]));
  centers[movedId] = start;
  const orderFrom = (origin: Point) => [...others].sort((a, b) => distance(centers[a], origin) - distance(centers[b], origin) || (a < b ? -1 : 1));

  const separate = (order: string[]) => {
    const fixed = [movedId];
    for (const id of order) {
      const point = centers[id];
      const hit = fixed.find((other) => distance(point, centers[other]) < collisionRadius(id) + collisionRadius(other));
      if (hit !== undefined) {
        const unit = direction(point.x - centers[hit].x, point.y - centers[hit].y, motion);
        const intervals = fixed
          .flatMap((other) => {
            const interval = collisionInterval(point, unit, centers[other], collisionRadius(id) + collisionRadius(other));
            return interval && interval[1] >= 0 ? [interval] : [];
          })
          .sort((a, b) => a[0] - b[0]);
        let push = 0;
        for (const [entry, exit] of intervals) {
          if (entry > push) break;
          push = Math.max(push, exit + COLLISION_GAP);
        }
        centers[id] = { x: point.x + unit.x * push, y: point.y + unit.y * push };
      }
      fixed.push(id);
    }
  };

  separate(orderFrom(start));
  // Short steps give nearby bots a chance to slide sideways. Every step is also swept,
  // so the fixed step cap cannot let a large pointer jump tunnel through a neighbor.
  const steps = Math.min(64, Math.max(1, Math.ceil(distance(start, end) / 24)));
  for (let step = 1; step <= steps; step++) {
    const previous = centers[movedId];
    const next = { x: start.x + ((end.x - start.x) * step) / steps, y: start.y + ((end.y - start.y) * step) / steps };
    const length = distance(previous, next);
    const order = orderFrom(previous);
    if (length > 0)
      for (const id of order) {
        const radius = collisionRadius(movedId) + collisionRadius(id);
        const interval = collisionInterval(previous, motion, centers[id], radius);
        if (!interval || interval[1] <= 0 || interval[0] > length) continue;
        const contact = Math.max(0, interval[0]);
        const normal = direction(centers[id].x - previous.x - motion.x * contact, centers[id].y - previous.y - motion.y * contact, motion);
        centers[id] = { x: next.x + normal.x * (radius + COLLISION_GAP), y: next.y + normal.y * (radius + COLLISION_GAP) };
      }
    centers[movedId] = next;
    separate(order);
  }

  const result = { ...points };
  let changed = !points[movedId] || source.x !== target.x || source.y !== target.y;
  if (changed) result[movedId] = { ...target };
  for (const id of others) {
    const original = collisionCenter(id, points[id]);
    if (centers[id].x === original.x && centers[id].y === original.y) continue;
    result[id] = { x: centers[id].x, y: centers[id].y * COLLISION_STRETCH - collisionOffset(id) };
    changed = true;
  }
  return changed ? result : points;
}

export function initialAgentPosition(index: number): Point {
  const ring = Math.floor(index / 6);
  // Fixed slots keep sequential arrivals apart without moving existing agents.
  const angle = [Math.PI * 0.8, Math.PI * 0.2, -Math.PI / 2, Math.PI / 2, -Math.PI * 0.8, -Math.PI * 0.2][index % 6];
  return { x: Math.cos(angle) * (300 + ring * 320), y: Math.sin(angle) * (235 + ring * 280) };
}

const names = [
  "Moses",
  "Noah",
  "Esther",
  "Jonah",
  "Ruth",
  "David",
  "Mary",
  "Daniel",
  "Deborah",
  "Elijah",
  "Sarah",
  "Gideon",
  "Miriam",
  "Isaac",
  "Ezekiel",
  "Solomon",
];
export function canvasAgentName(index: number): string {
  return `${names[index % names.length]}${index >= names.length ? ` ${Math.floor(index / names.length) + 1}` : ""}`;
}

/** The bots' colours, given out in turn; each one's fill is its --bot-tint in subagent-canvas.css. */
const SUBAGENT_COLORS = ["mint", "blue", "peach", "lilac"] as const;
export type SubagentColor = (typeof SUBAGENT_COLORS)[number];
export const SUBAGENT_TINTS: Record<SubagentColor, string> = { mint: "#b4dccb", blue: "#b8d5fb", peach: "#eec9a6", lilac: "#d1c3ef" };
export const subagentColor = (index: number): SubagentColor => SUBAGENT_COLORS[index % SUBAGENT_COLORS.length]!;

/**
 * A subagent as the Subagents view shows it, by its place among the Chat's subagents: its name, its bot's colour and
 * the task it was given. Null for one the Chat doesn't list.
 */
export function subagentPersona(agents: readonly Subagent[], id: string): { name: string; color: SubagentColor; task: string } | null {
  const index = agents.findIndex((agent) => agent.id === id);
  if (index === -1) return null;
  return { name: canvasAgentName(index), color: subagentColor(index), task: agents[index]!.title };
}

export function fitAgents(points: Point[], width: number, height: number): Viewport {
  const left = Math.min(...points.map((point) => point.x)) - 120;
  const right = Math.max(...points.map((point) => point.x)) + 120;
  const top = Math.min(...points.map((point) => point.y)) - 100;
  const bottom = Math.max(...points.map((point) => point.y)) + 110;
  const scale = Math.max(0.15, Math.min(1, (width - 48) / (right - left), (height - 90) / (bottom - top)));
  return { x: width / 2 - ((left + right) / 2) * scale, y: (height - 40) / 2 - ((top + bottom) / 2) * scale, scale };
}

/** Only actual, recent exchanges animate. Reading tools or thinking never invents a conversation. */
export function recentCommunications(agents: Subagent[], now: number): SubagentCommunication[] {
  const ids = new Set(agents.map((agent) => agent.id));
  const latest = new Map<string, SubagentCommunication>();
  for (const agent of agents)
    for (const message of agent.communications ?? []) {
      if (now - message.at > COMMUNICATION_TTL_MS || message.at > now + 1000) continue;
      if ((message.fromId !== null && !ids.has(message.fromId)) || (message.toId !== null && !ids.has(message.toId))) continue;
      if (message.fromId === message.toId) continue;
      const pair = JSON.stringify([message.fromId, message.toId]);
      if (!latest.has(pair) || latest.get(pair)!.at < message.at) latest.set(pair, message);
    }
  return [...latest.values()].sort((a, b) => a.at - b.at);
}

/** Wake React only when an exchange enters or leaves its display window. */
export function nextCommunicationChange(agents: Subagent[], now: number, displayed = recentCommunications(agents, now)): number | undefined {
  const ids = new Set(agents.map((agent) => agent.id));
  let next = Infinity;
  for (const message of displayed) next = Math.min(next, message.at + COMMUNICATION_TTL_MS + 1);
  for (const agent of agents)
    for (const message of agent.communications ?? []) {
      if (message.at <= now + 1000) continue;
      if ((message.fromId !== null && !ids.has(message.fromId)) || (message.toId !== null && !ids.has(message.toId)) || message.fromId === message.toId)
        continue;
      next = Math.min(next, message.at - 1000);
    }
  return Number.isFinite(next) ? next : undefined;
}

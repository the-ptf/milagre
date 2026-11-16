import type { CanvasLink } from "@milagre/shared/chat-links";
import type { RegisteredProject } from "./client";

/** What reads a computer's Links: its client. Kept apart from React Native, so the store runs in unit tests. */
type Caller = { call: <T>(method: string, args: unknown[]) => Promise<T> };
export type LinksState = { available: boolean; links: CanvasLink[]; projects: RegisteredProject[] };

const linksUnsupported = (error: unknown) => /not available from mobile/i.test((error as Error)?.message ?? "");

const states = new WeakMap<Caller, LinksState>();
const listeners = new Set<() => void>();
const reading = new Map<Caller, { work: Promise<void>; again: boolean }>();

function set(client: Caller, next: LinksState) {
  states.set(client, next);
  for (const listener of listeners) listener();
}

export function linksOf(client: Caller | null): LinksState | null {
  return client ? (states.get(client) ?? null) : null;
}

export function subscribeLinks(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function refreshLinks(client: Caller): Promise<void> {
  const running = reading.get(client);
  if (running) {
    running.again = true;
    return running.work;
  }
  const entry = { work: Promise.resolve(), again: false };
  entry.work = (async () => {
    try {
      do {
        entry.again = false;
        await read(client);
      } while (entry.again);
    } finally {
      reading.delete(client);
    }
  })();
  reading.set(client, entry);
  return entry.work;
}

async function read(client: Caller) {
  try {
    const [links, projects] = await Promise.all([client.call<CanvasLink[]>("canvas:links", []), client.call<RegisteredProject[]>("project:registry", [])]);
    const available = Array.isArray(links) && Array.isArray(projects);
    set(client, { available, links: available ? links : [], projects: available ? projects : [] });
  } catch (error) {
    if (linksUnsupported(error) || !states.has(client)) set(client, { available: false, links: [], projects: [] });
  }
}

export function setLinks(client: Caller, links: CanvasLink[]) {
  const current = states.get(client);
  if (current) set(client, { ...current, links });
  const running = reading.get(client);
  if (running) running.again = true;
  else if (!current) void refreshLinks(client);
}

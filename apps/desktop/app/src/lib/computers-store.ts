import type { ComputersSnapshot } from "../electron.d.ts";
import { ThisComputer } from "./shortcut-hints.ts";

// The window's list of computers, kept current from main (computers:changed). Apart from computers.ts so a module read
// outside React (the Routines store) follows it without the window's settings.
let snapshot: ComputersSnapshot = { thisMac: ThisComputer, computers: [] };
const listeners = new Set<() => void>();
let started = false;
function store(next: ComputersSnapshot | null | undefined) {
  if (!next || !Array.isArray(next.computers)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}
function start() {
  if (started || typeof window === "undefined" || !window.milagre?.computers?.list) return;
  started = true;
  let heard = false;
  window.milagre.onComputersChanged?.((next) => {
    heard = true;
    store(next);
  });
  void loadFirst(window.milagre.computers.list(), () => heard);
}
async function loadFirst(request: Promise<ComputersSnapshot>, heard: () => boolean) {
  try {
    const next = await request;
    if (!heard()) store(next);
  } catch {
    // main keeps pushing computers:changed; the list stays as it was
  }
}

/** Listens for the paired computers as main reports them, whatever Other computers says (a switched-off one is "off"). */
export function subscribeComputers(listener: () => void) {
  start();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The paired computers as main last reported them. */
export const computersSnapshot = () => snapshot;

import type { ComputersSnapshot } from "../electron.d.ts";
import { ThisComputer } from "./shortcut-hints.ts";

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
  } catch {}
}

export function subscribeComputers(listener: () => void) {
  start();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const computersSnapshot = () => snapshot;

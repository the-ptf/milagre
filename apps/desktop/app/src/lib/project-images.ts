import { useEffect, useSyncExternalStore } from "react";
import { bridgeForKey } from "./computer-bridge";

const images = new Map<string, string | null>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function load(path: string) {
  if (!path || images.has(path)) return;
  images.set(path, null);
  (window.milagre ? bridgeForKey(path).getProjectImage(path) : Promise.resolve(null)).then(
    (src) => {
      images.set(path, src);
      changed();
    },
    () => {},
  );
}

export function setProjectImage(path: string, src: string | null) {
  images.set(path, src);
  changed();
}

export function useProjectImages(paths: string[]) {
  useSyncExternalStore(subscribe, () => version);
  const key = paths.join("\n");
  useEffect(() => {
    for (const path of key.split("\n")) load(path);
  }, [key]);
  return (path: string) => images.get(path) ?? null;
}

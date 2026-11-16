import { useSyncExternalStore } from "react";

type SplashPhase = "showing" | "gone";
type Splash = { phase: SplashPhase; leaving: boolean; shown: boolean };

let splash: Splash = { phase: "showing", leaving: false, shown: true };
let held = 0;
let drawnFirst = false;
const listeners = new Set<() => void>();

function update(next: Partial<Splash>) {
  splash = { ...splash, ...next };
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const splashDrawnFirst = () => {
  drawnFirst = true;
};
export const isSplashDrawnFirst = () => drawnFirst;
export function holdSplash() {
  held++;
  if (!splash.shown) update({ shown: true });
  return () => {
    held--;
  };
}
export function settleSplash() {
  if (!held && splash.shown) update({ shown: false });
}
export const splashLeft = () => update({ phase: "gone" });
export const setSplashLeaving = (leaving: boolean) => {
  if (splash.leaving !== leaving) update({ leaving });
};
export const useSplash = () => useSyncExternalStore(subscribe, () => splash);

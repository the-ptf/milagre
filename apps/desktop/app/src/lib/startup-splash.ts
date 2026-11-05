import { useSyncExternalStore } from "react";

type SplashPhase = "intro" | "done" | "gone";
type Splash = { phase: SplashPhase; leaving: boolean };

// The splash paints from the first chunk, before the app has loaded (main.tsx), so the app reaches it through this store.
let splash: Splash = { phase: "intro", leaving: false };
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

/** main.tsx draws the splash, before the app loads. Without it (the app on its own), the app draws it. */
export const splashDrawnFirst = () => {
  drawnFirst = true;
};
export const isSplashDrawnFirst = () => drawnFirst;
/** The logo is whole: the app may show under it. */
export const splashIntroEnded = () => {
  if (splash.phase === "intro") update({ phase: "done" });
};
/** The fade has finished. */
export const splashLeft = () => update({ phase: "gone" });
export const setSplashLeaving = (leaving: boolean) => {
  if (splash.leaving !== leaving) update({ leaving });
};
export const useSplash = () => useSyncExternalStore(subscribe, () => splash);

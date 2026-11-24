import { useCallback, useEffect, useSyncExternalStore } from "react";
import { DESIGN_MODES, type DesignMode } from "@milagre/shared/design-modes";

const modes = new Map<string, DesignMode>();
const offers = new Map<string, readonly DesignMode[]>();
const listeners = new Set<() => void>();
const keyOf = (chatId: string, id: string) => `${chatId}\n${id}`;
const LIGHT_ONLY: readonly DesignMode[] = ["light"];

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function changed() {
  for (const listener of listeners) listener();
}

function choose(key: string, mode: DesignMode) {
  if (mode === "light") modes.delete(key);
  else modes.set(key, mode);
}

const shownMode = (key: string): DesignMode => {
  const mode = modes.get(key) ?? "light";
  return (offers.get(key) ?? LIGHT_ONLY).includes(mode) ? mode : "light";
};

/**
 * The color mode the canvas shows one design in; every design starts in light, and the choice lasts until the app quits.
 * `offered` is the modes the design's tokens define, which a page-wide switch reads back.
 */
export function useDesignMode(chatId: string, id: string, offered: readonly DesignMode[] = LIGHT_ONLY): [DesignMode, (mode: DesignMode) => void] {
  const key = keyOf(chatId, id);
  const read = (): DesignMode => modes.get(key) ?? "light";
  const mode = useSyncExternalStore(subscribe, read, read);
  const offeredKey = offered.join(",");
  useEffect(() => {
    offers.set(key, offeredKey.split(",") as DesignMode[]);
    changed();
    return () => {
      offers.delete(key);
      changed();
    };
  }, [key, offeredKey]);
  const set = useCallback(
    (next: DesignMode) => {
      choose(key, next);
      changed();
    },
    [key],
  );
  return [mode, set];
}

/**
 * One color mode for every design `ids` names: the modes any of them defines, the mode they all show (null when they
 * differ), and a setter that switches each design that defines the mode and puts the others back in light.
 */
export function usePageDesignMode(chatId: string, ids: readonly string[]) {
  const keys = ids.map((id) => keyOf(chatId, id));
  const read = () => {
    const offered = DESIGN_MODES.filter((mode) => keys.some((key) => (offers.get(key) ?? LIGHT_ONLY).includes(mode)));
    const shown = new Set(keys.map(shownMode));
    return `${offered.join(",")}|${shown.size === 1 ? [...shown][0] : ""}`;
  };
  const [offered, common] = useSyncExternalStore(subscribe, read, read).split("|");
  const keysKey = JSON.stringify(keys);
  const setMode = useCallback(
    (mode: DesignMode) => {
      for (const key of JSON.parse(keysKey) as string[]) choose(key, (offers.get(key) ?? LIGHT_ONLY).includes(mode) ? mode : "light");
      changed();
    },
    [keysKey],
  );
  return { modes: (offered ? offered.split(",") : []) as DesignMode[], mode: (common || null) as DesignMode | null, setMode };
}

type Storage = { getItemAsync: (key: string) => Promise<string | null>; setItemAsync: (key: string, value: string) => Promise<void> };

/** Where handheld mode's floating button rests: against one side edge, `y` of the way down the room it has. */
export type HandheldSpot = { side: "left" | "right"; y: number };

const KEY = "milagre.handheld-button.v1";
export const DEFAULT_HANDHELD_SPOT: HandheldSpot = { side: "right", y: 0.62 };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function parseHandheldSpot(raw: string | null): HandheldSpot {
  try {
    const value = JSON.parse(raw || "null");
    if ((value?.side === "left" || value?.side === "right") && Number.isFinite(value.y)) return { side: value.side, y: clamp(value.y, 0, 1) };
  } catch {}
  return DEFAULT_HANDHELD_SPOT;
}

/** A button of `size` let go at `x`, `y` in a `width` by `height` room settles against the nearer side edge. */
export function landHandheldSpot(x: number, y: number, size: number, width: number, height: number): HandheldSpot {
  return { side: x + size / 2 < width / 2 ? "left" : "right", y: clamp(y / Math.max(1, height - size), 0, 1) };
}

export function handheldSpotPoint(spot: HandheldSpot, size: number, width: number, height: number) {
  return { x: spot.side === "left" ? 0 : Math.max(0, width - size), y: spot.y * Math.max(0, height - size) };
}

export function createHandheldSpotStore(storage: Storage) {
  let spot: HandheldSpot | null = null;
  let loading: Promise<HandheldSpot> | null = null;
  return {
    peek: () => spot,
    load(): Promise<HandheldSpot> {
      if (spot) return Promise.resolve(spot);
      loading ??= storage
        .getItemAsync(KEY)
        .catch(() => null)
        .then((raw) => (spot ??= parseHandheldSpot(raw)));
      return loading;
    },
    save(next: HandheldSpot): Promise<void> {
      spot = next;
      return storage.setItemAsync(KEY, JSON.stringify(next)).catch(() => {});
    },
  };
}

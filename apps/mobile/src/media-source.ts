import { useEffect, useState } from "react";
import type { ImageSourcePropType } from "react-native";
import type { MediaValue } from "./viewer-store";

/** Retain the distinction between a pending authenticated fetch and one that was rejected. */
export function useMediaState(source: MediaValue | null): { source: ImageSourcePropType | null; failed: boolean } {
  const pending = typeof (source as Promise<ImageSourcePropType> | null)?.then === "function" ? (source as Promise<ImageSourcePropType>) : null;
  const [loaded, setLoaded] = useState<{ from: Promise<ImageSourcePropType>; value: ImageSourcePropType | null } | null>(null);
  useEffect(() => {
    if (!pending) return;
    let current = true;
    pending.then(
      (value) => {
        if (current) setLoaded({ from: pending, value });
        return undefined;
      },
      () => {
        if (current) setLoaded({ from: pending, value: null });
        return undefined;
      },
    );
    return () => {
      current = false;
    };
  }, [pending]);
  if (!pending) return { source: source as ImageSourcePropType | null, failed: false };
  const settled = loaded?.from === pending;
  return { source: settled ? loaded.value : null, failed: settled && loaded.value === null };
}

export function useMedia(source: MediaValue | null): ImageSourcePropType | null {
  return useMediaState(source).source;
}

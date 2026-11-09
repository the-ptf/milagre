import { useEffect, useRef } from "react";
import { findNodeHandle, type TextInputInstance } from "react-native";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";
import type { PastedImage } from "./attachment-picker";

type ImagePasteModule = {
  addListener: (event: "imagePaste", listener: (image: PastedImage & { target: number }) => void) => EventSubscription;
  attachAsync: (target: number) => Promise<boolean>;
  detachAsync: (target: number) => Promise<void>;
};
// Older binaries retain the explicit Paste image action until the new build is installed.
const nativePaste = requireOptionalNativeModule<ImagePasteModule>("MilagreImagePaste");

export function useImagePaste(onPaste?: (image: PastedImage) => void) {
  const ref = useRef<TextInputInstance>(null);
  const target = useRef<number | null>(null);
  const latest = useRef(onPaste);
  const enabled = Boolean(onPaste);
  useEffect(() => {
    latest.current = onPaste;
  }, [onPaste]);
  useEffect(() => {
    if (!nativePaste || !enabled) return;
    const subscription = nativePaste.addListener("imagePaste", (image) => {
      if (image.target === target.current) latest.current?.(image);
    });
    return () => {
      subscription.remove();
      if (target.current !== null) void nativePaste.detachAsync(target.current).catch(() => {});
      target.current = null;
    };
  }, [enabled]);
  const attach = () => {
    if (!nativePaste || !onPaste) return;
    const tag = findNodeHandle(ref.current) ?? null;
    if (tag !== null && tag !== target.current) {
      if (target.current !== null) void nativePaste.detachAsync(target.current).catch(() => {});
      target.current = tag;
      void nativePaste
        .attachAsync(tag)
        .then((attached) => {
          if (!attached && target.current === tag) target.current = null;
        })
        .catch(() => {
          if (target.current === tag) target.current = null;
        });
    }
  };
  return { ref, onLayout: attach, onFocus: attach };
}

import { useCallback, useState } from "react";
import { EASE_OUT, scaled } from "../../lib/ease";

export const MORPH_SURFACE =
  "transition-[width,height,right,border-radius,box-shadow] duration-[calc(var(--duration-slow)*var(--motion-scale))] ease-enter motion-reduce:transition-none motion-reduce:duration-0";

export const HIDDEN_FACE = "invisible transition-[visibility] duration-[calc(100ms*var(--motion-scale))] motion-reduce:duration-0";

export function morphFace(shown: boolean, reduce: boolean | null, scale = 1) {
  return {
    initial: false as const,
    animate: shown
      ? { opacity: 1, filter: "blur(0px)", transition: { duration: reduce ? 0 : scaled(0.18, scale), delay: reduce ? 0 : scaled(0.06, scale), ease: EASE_OUT } }
      : { opacity: 0, filter: reduce ? "blur(0px)" : "blur(4px)", transition: { duration: reduce ? 0 : scaled(0.1, scale), ease: EASE_OUT } },
    inert: !shown,
    "aria-hidden": !shown || undefined,
  };
}

export function useSize() {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const read = () => setSize({ width: node.offsetWidth, height: node.offsetHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [size, ref] as const;
}

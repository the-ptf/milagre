import { useCallback, useState } from "react";
import { EASE_OUT, scaled } from "../../lib/ease";

/**
 * A morphing surface: one box that grows from a small face (a pill) into a large one (a card or panel). Both faces
 * stay mounted inside it and crossfade, so focus can return to the small face as the box shrinks back; the box takes
 * the measured size of the face on show. UpdateNotice and TaskTrack use it.
 */

/** The box's own transition: width, height, corners and a right-edge offset move together; reduced motion jumps. */
export const MORPH_SURFACE =
  "transition-[width,height,right,border-radius,box-shadow] duration-[calc(300ms*var(--motion-scale))] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:duration-0";

/** Classes for the face that is not on show. Only hiding transitions visibility, which stays visible through the fade. */
export const HIDDEN_FACE = "invisible transition-[visibility] duration-[calc(100ms*var(--motion-scale))] motion-reduce:duration-0";

/**
 * Motion props for a face. A face shows in the same commit and goes invisible as its fade ends, so a hidden face's
 * text and controls leave the page; it is inert and hidden from assistive tech meanwhile.
 */
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

/** Reports an element's border-box size as it changes. */
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

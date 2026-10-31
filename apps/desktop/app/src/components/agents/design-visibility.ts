type Visibility = (visible: boolean) => void;

/** One observer for a canvas, with a viewport-sized prefetch margin. Removed frames ignore queued callbacks. */
export function createDesignVisibility() {
  const targets = new Map<Element, Visibility>();
  let observer: IntersectionObserver | null = null;
  return {
    connect(root: HTMLElement) {
      const resize = () => {
        observer?.disconnect();
        const current = new IntersectionObserver(
          (entries) => {
            if (observer !== current) return;
            for (const entry of entries) targets.get(entry.target)?.(entry.isIntersecting);
          },
          { root, rootMargin: `${root.clientHeight}px ${root.clientWidth}px` },
        );
        observer = current;
        for (const target of targets.keys()) current.observe(target);
      };
      resize();
      const sizes = new ResizeObserver(resize);
      sizes.observe(root);
      return () => {
        sizes.disconnect();
        observer?.disconnect();
        observer = null;
      };
    },
    watch(target: Element, onVisible: Visibility) {
      targets.set(target, onVisible);
      observer?.observe(target);
      return () => {
        observer?.unobserve(target);
        targets.delete(target);
      };
    },
  };
}

export const designDensity = () => window.devicePixelRatio || 1;
export function subscribeDesignDensity(notify: () => void) {
  let query = matchMedia(`(resolution: ${designDensity()}dppx)`);
  const changed = () => {
    query.removeEventListener("change", changed);
    query = matchMedia(`(resolution: ${designDensity()}dppx)`);
    query.addEventListener("change", changed);
    notify();
  };
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
}

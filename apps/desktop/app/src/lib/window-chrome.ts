import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

type Overlay = EventTarget & {
  visible: boolean;
  getTitlebarAreaRect: () => DOMRect;
};
type ChromeLayout = { sidebarLeft: number; rightInset: number; controlsEnd: number };

function overlay(): Overlay | undefined {
  return (navigator as Navigator & { windowControlsOverlay?: Overlay }).windowControlsOverlay;
}

/** Geometry belongs to the local window, not to the computer whose Project it displays. */
function readWindowChrome(): ChromeLayout {
  const mode = window.milagreWindowChrome?.controls ?? "external";
  let sidebarLeft = mode === "leading" ? 88 : 12;
  let rightInset = mode === "overlay" ? 150 : 0;
  const controls = overlay();
  if (mode !== "external" && controls) {
    if (!controls.visible) {
      sidebarLeft = 12;
      rightInset = 0;
    } else {
      const rect = controls.getTitlebarAreaRect();
      if (rect.width > 0) {
        sidebarLeft = rect.x > 0 ? rect.x + 8 : 12;
        const trailing = Math.max(0, window.innerWidth - rect.right);
        rightInset = trailing > 0 ? trailing + 8 : 0;
      }
    }
  }
  return { sidebarLeft, rightInset, controlsEnd: sidebarLeft + 32 + 8 };
}

function subscribe(notify: () => void) {
  const controls = overlay();
  controls?.addEventListener("geometrychange", notify);
  window.addEventListener("resize", notify);
  return () => {
    controls?.removeEventListener("geometrychange", notify);
    window.removeEventListener("resize", notify);
  };
}

// A primitive snapshot stays stable between geometry events, as useSyncExternalStore requires.
function snapshot() {
  const { sidebarLeft, rightInset } = readWindowChrome();
  return `${sidebarLeft}:${rightInset}`;
}

export function useWindowChrome(): ChromeLayout {
  useSyncExternalStore(subscribe, snapshot);
  return readWindowChrome();
}

/**
 * Insets that keep a bar along the top of <main> clear of the window controls and the sidebar toggle, from where its
 * offset parent starts. Collapsing the sidebar moves that edge under them.
 */
export function useControlsClearance<T extends HTMLElement>(open: boolean) {
  const { controlsEnd, rightInset } = useWindowChrome();
  const bar = useRef<T>(null);
  const [inset, setInset] = useState({ paddingLeft: 0, paddingRight: 0 });
  useLayoutEffect(() => {
    const host = bar.current?.offsetParent;
    if (!open || !(host instanceof HTMLElement)) return;
    const update = () => {
      const rect = host.getBoundingClientRect();
      setInset({ paddingLeft: Math.max(0, controlsEnd - rect.left - 12), paddingRight: Math.max(0, rect.right - window.innerWidth + rightInset) });
    };
    update();
    // Collapsing the sidebar resizes <main>, which is what moves its left edge.
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [open, controlsEnd, rightInset]);
  return { bar, inset };
}

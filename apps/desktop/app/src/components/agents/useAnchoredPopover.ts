import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { useDismiss } from "../../lib/use-dismiss";

export function useAnchoredPopover({
  opened,
  setOpened,
  trigger,
  panel,
  width: preferred,
  height = 360,
}: {
  opened: boolean;
  setOpened: (opened: boolean) => void;
  trigger: RefObject<HTMLElement | null>;
  panel: RefObject<HTMLElement | null>;
  width: number;
  height?: number;
}) {
  const [bounds, setBounds] = useState({ left: 12, bottom: 60, width: preferred, maxHeight: Math.min(height, 320) });

  const position = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(preferred, window.innerWidth - 24);
    setBounds({
      left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
      bottom: window.innerHeight - rect.top + 8,
      width,
      maxHeight: Math.max(60, Math.min(height, rect.top - 20)),
    });
  };

  useLayoutEffect(() => {
    if (opened) position();
  }, [opened, preferred, height]);

  useDismiss(
    opened,
    () => setOpened(false),
    (target) => !!(panel.current?.contains(target) || trigger.current?.contains(target)),
    position,
  );

  useEffect(() => {
    if (!opened) return;
    const frame = requestAnimationFrame(() => (panel.current?.querySelector<HTMLButtonElement>("button") ?? panel.current)?.focus());
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpened(false);
      trigger.current?.focus();
    };
    document.addEventListener("keydown", escape, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", escape, true);
    };
  }, [opened]);

  return bounds;
}

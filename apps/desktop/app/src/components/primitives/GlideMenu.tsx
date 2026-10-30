import { useEffect, useRef, useState, type ReactNode } from "react";

export default function GlideMenu({
  children,
  className = "",
  highlightClassName = "",
  rowSelector = "[data-row]",
}: {
  children: ReactNode;
  className?: string;
  highlightClassName?: string;
  rowSelector?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<{ top: number; height: number } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const move = (event: PointerEvent) => {
      const target = event.target as Element;
      const row = target.closest(rowSelector);
      if (!row || !root.contains(row)) return;
      const rootRect = root.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      setHighlight({ top: rowRect.top - rootRect.top, height: rowRect.height });
    };
    const leave = () => setHighlight(null);
    root.addEventListener("pointerover", move);
    root.addEventListener("pointerleave", leave);
    return () => {
      root.removeEventListener("pointerover", move);
      root.removeEventListener("pointerleave", leave);
    };
  }, [rowSelector]);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 z-0 transition-[top,height,opacity] duration-base ${highlightClassName}`}
        style={{ top: highlight?.top ?? 0, height: highlight?.height ?? 0, opacity: highlight ? 1 : 0 }}
      />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

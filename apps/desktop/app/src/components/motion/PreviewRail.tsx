import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useMemo, useId, useLayoutEffect, useRef, useState } from "react";
import { EASE_OUT, SPRING_LAYOUT, scaled, scaledSpring, useMotionScale } from "../../lib/ease";

export interface PreviewRailItem {
  id: string;
  label: string;
  ariaLabel?: string;
  description?: ReactNode;
}

interface PreviewRailProps {
  items: PreviewRailItem[];
  label?: string;
  activeId?: string;
  onActiveChange?: (id: string) => void;
  onItemSelect?: (item: PreviewRailItem) => void;
  renderPreview?: (item: PreviewRailItem) => ReactNode;
  showPreview?: boolean;
  previewSide?: "before" | "after";
  highlightActive?: boolean;
  itemSize?: number;
  children?: ReactNode;
  className?: string;
  railClassName?: string;
  previewContainerClassName?: string;
  previewClassName?: string;
}

function DefaultPreview({ item }: { item: PreviewRailItem }) {
  return (
    <div data-slot="preview-rail-card" className="rounded-xl border border-line bg-surface p-3 shadow-raised">
      <p data-slot="preview-rail-title" className="font-medium text-ink">
        {item.label}
      </p>
      {item.description ? (
        <div data-slot="preview-rail-description" className="mt-1 text-sm leading-5 text-ink-2">
          {item.description}
        </div>
      ) : null}
    </div>
  );
}

export function PreviewRail({
  items,
  label = "Section navigation",
  activeId,
  onActiveChange,
  onItemSelect,
  renderPreview,
  showPreview = true,
  previewSide = "after",
  highlightActive = false,
  itemSize = 24,
  children,
  className = "",
  railClassName = "",
  previewContainerClassName = "",
  previewClassName = "",
}: PreviewRailProps) {
  const uid = useId();
  const speed = useMotionScale();
  const reduce = speed === 0;
  const [internalActiveId, setInternalActiveId] = useState(items[0]?.id ?? "");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const previewRowRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [previewBounds, setPreviewBounds] = useState<{ offset: number; maxHeight?: number }>({ offset: 0 });
  const selectedId = activeId ?? internalActiveId;
  const displayedId = hoveredId ?? pinnedId ?? focusedId ?? "";
  const highlightedId = displayedId || (highlightActive ? selectedId : "");
  const displayedIndex = items.findIndex((item) => item.id === highlightedId);
  const rowTemplate = items.length ? `repeat(${items.length}, minmax(0, ${itemSize}px))` : undefined;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const row = previewRowRef.current;
    const preview = previewRef.current;
    if (!root || !row || !preview) return;

    // Keep the whole card inside the conversation, even at the first/last tick
    // or after the composer grows and reduces the available height.
    const measure = () => {
      const rootRect = root.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const maxHeight = Math.max(0, rootRect.height - 12);
      const height = Math.min(preview.offsetHeight, maxHeight);
      const centeredTop = rowRect.top - rootRect.top + (rowRect.height - height) / 2;
      const top = Math.max(6, Math.min(centeredTop, rootRect.height - height - 6));
      const offset = top - centeredTop;
      setPreviewBounds((current) => (current.offset === offset && current.maxHeight === maxHeight ? current : { offset, maxHeight }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [displayedId, items, itemSize, showPreview]);

  const selectItem = useCallback(
    (item: PreviewRailItem) => {
      if (activeId === undefined) setInternalActiveId(item.id);
      onActiveChange?.(item.id);
      onItemSelect?.(item);
    },
    [activeId, onActiveChange, onItemSelect],
  );

  // The scrolled content changes independently; reuse its navigation until a rail input changes.
  const navigation = useMemo(
    () => (
      <>
        <nav
          aria-label={label}
          onPointerLeave={() => setHoveredId(null)}
          style={{ gridTemplateRows: rowTemplate }}
          className={`absolute inset-y-0 left-0 z-10 grid w-6 content-center ${railClassName}`}
        >
          {items.map((item, index) => {
            const selected = item.id === selectedId;
            const highlighted = item.id === highlightedId;
            const distance = displayedIndex < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - displayedIndex);
            const scale = highlighted ? 1 : distance === 1 ? 0.68 : distance === 2 ? 0.44 : 0.25;

            return (
              <button
                key={item.id}
                data-slot="preview-rail-item"
                type="button"
                aria-label={item.ariaLabel ?? item.label}
                aria-current={selected ? "location" : undefined}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") setHoveredId(item.id);
                }}
                onPointerDown={(event) => {
                  if (event.pointerType !== "mouse") setPinnedId(item.id);
                }}
                onFocus={(event) => {
                  if (event.currentTarget.matches(":focus-visible")) setFocusedId(item.id);
                }}
                onBlur={(event) => {
                  if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setFocusedId(null);
                }}
                onClick={() => selectItem(item)}
                style={{ height: "100%" }}
                className="relative flex h-6 w-6 items-center justify-end text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <motion.span
                  data-slot="preview-rail-tick"
                  aria-hidden="true"
                  animate={{ scaleX: scale }}
                  transition={scaledSpring(SPRING_LAYOUT, speed)}
                  className={`block h-px w-4 origin-right bg-current ${highlighted ? "text-ink" : "text-line-strong"}`}
                />
              </button>
            );
          })}
        </nav>

        {showPreview ? (
          <div
            aria-hidden="true"
            style={{ gridTemplateRows: rowTemplate }}
            className={`pointer-events-none absolute inset-y-0 right-16 left-4 z-50 grid content-center ${previewSide === "after" ? "right-4 left-16" : ""} ${previewContainerClassName}`}
          >
            {items.map((item) => (
              <div key={item.id} ref={item.id === displayedId ? previewRowRef : undefined} className="relative flex min-h-0 items-center">
                {item.id === displayedId ? (
                  <div
                    ref={previewRef}
                    style={{ transform: `translateY(${previewBounds.offset}px)`, maxHeight: previewBounds.maxHeight }}
                    className={`w-full max-w-sm overflow-hidden ${previewSide === "before" ? "ml-auto" : ""} ${previewClassName}`}
                  >
                    <motion.div layoutId={`preview-rail-card-${uid}`} transition={scaledSpring(SPRING_LAYOUT, speed)}>
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.div
                          key={item.id}
                          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4, filter: "blur(6px)" }}
                          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, filter: "blur(0px)" }}
                          exit={
                            reduce ? { opacity: 0 } : { opacity: 0, y: -2, filter: "blur(4px)", transition: { duration: scaled(0.12, speed), ease: EASE_OUT } }
                          }
                          transition={{ duration: scaled(0.18, speed), ease: EASE_OUT }}
                        >
                          {renderPreview ? renderPreview(item) : <DefaultPreview item={item} />}
                        </motion.div>
                      </AnimatePresence>
                    </motion.div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </>
    ),
    [
      items,
      label,
      selectedId,
      highlightedId,
      displayedIndex,
      railClassName,
      rowTemplate,
      reduce,
      speed,
      selectItem,
      showPreview,
      previewSide,
      previewContainerClassName,
      displayedId,
      previewBounds,
      previewClassName,
      uid,
      renderPreview,
    ],
  );

  return (
    <motion.div ref={rootRef} layoutRoot className={`isolate relative flex w-full ${className}`}>
      {navigation}

      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </motion.div>
  );
}

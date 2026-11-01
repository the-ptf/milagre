import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMotionScale } from "../../lib/ease";
import { useDismiss } from "../../lib/use-dismiss";
import { PILL_TONES, PillSlot, StatusPill } from "../primitives/StatusPill";
import Tooltip from "../primitives/Tooltip";
import { HIDDEN_FACE, MORPH_SURFACE, morphFace, useSize } from "./morph";

// The panel keeps this far from the window's edges and never takes more than this share of its height.
const EDGE = 12;
const VIEWPORT_SHARE = 0.7;

/**
 * A composer-row pill that grows in place into its panel, as the Tasks pill does: the pill and the panel are the two
 * faces of one surface hung from the pill's bottom-right corner, so the panel opens up and to the left over the
 * transcript without moving the row. The slot grows in when `shown` turns on and shrinks out when it turns off.
 *
 * Opening focuses the panel's first button; Escape, a press outside and the window losing focus close it, and a close
 * from the keyboard hands focus back to the pill.
 */
export function PillMorph({
  shown,
  slot,
  panelSlot,
  title,
  tooltip,
  opened,
  onOpenChange,
  width,
  height,
  fill = false,
  expanded = false,
  className = "",
  anchor = "right",
  pill,
  children,
}: {
  shown: boolean;
  /** data-slot of the row's spot and of the panel, e.g. "port-track" and "port-popover". */
  slot: string;
  panelSlot: string;
  /** The panel's accessible name. */
  title: string;
  tooltip: string;
  opened: boolean;
  onOpenChange: (opened: boolean) => void;
  width: number;
  /** The tallest the panel grows; shorter content gives a shorter panel, unless `fill` holds it at that height. */
  height: number;
  /** Hold the panel at its full height, for content with no height of its own (a live viewer). */
  fill?: boolean;
  /**
   * Pin the open surface to the whole window over a scrim, keeping its content mounted (the browser's Expand). The
   * composer row lifts itself above the window's chrome while it holds an expanded panel (ChatComposer).
   */
  expanded?: boolean;
  /** Placement of the pill's spot in the composer row (`mr-auto` for a pill at the row's left). */
  className?: string;
  /** The pill corner the panel hangs from: the bottom-right (opens to the left) or, for a pill at the row's left, the bottom-left. */
  anchor?: "left" | "right";
  pill: Omit<ComponentProps<typeof StatusPill>, "ref" | "bare" | "onClick">;
  /** The panel; as a function it gets a close that hands focus back to the pill, for the panel's own close control. */
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  return (
    <AnimatePresence initial={false}>
      {shown && (
        <Morph key={slot} {...{ slot, panelSlot, title, tooltip, opened, onOpenChange, width, height, fill, expanded, className, anchor, pill }}>
          {children}
        </Morph>
      )}
    </AnimatePresence>
  );
}

function Morph({
  slot,
  panelSlot,
  title,
  tooltip,
  opened,
  onOpenChange,
  width: preferredWidth,
  height: preferredHeight,
  fill,
  expanded,
  className,
  anchor = "right",
  pill,
  children,
}: Omit<ComponentProps<typeof PillMorph>, "shown">) {
  const side = anchor === "left" ? "left-0" : "right-0";
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const scale = useMotionScale();
  const reduce = scale === 0;
  // The panel's size, and how far its right edge moves past the pill's so a narrow window still fits it.
  const [room, setRoom] = useState({ width: preferredWidth, height: preferredHeight, shift: 0 });
  const [pillSize, measurePill] = useSize();
  const [panelSize, measurePanel] = useSize();
  const refocus = useRef(false);
  const fit = () => {
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    const width = Math.round(Math.max(0, Math.min(preferredWidth, window.innerWidth - 2 * EDGE)));
    const height = Math.round(Math.max(0, Math.min(preferredHeight, window.innerHeight * VIEWPORT_SHARE, box.bottom - EDGE)));
    // Anchored to the pill's edge when that fits; otherwise moved just enough to clear the window's padding on the far side.
    const shift = anchor === "left" ? Math.max(0, box.left + width - (window.innerWidth - EDGE)) : Math.max(0, EDGE - (box.right - width));
    setRoom((current) => (current.width === width && current.height === height && current.shift === shift ? current : { width, height, shift }));
  };
  const close = (returnFocus: boolean) => {
    refocus.current = returnFocus;
    onOpenChange(false);
  };
  useDismiss(
    opened,
    () => close(false),
    (target) => !!root.current?.contains(target),
    fit,
  );
  // The room is measured before the box starts growing, whichever way the panel was opened.
  useLayoutEffect(() => {
    if (opened) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, preferredWidth, preferredHeight]);
  useEffect(() => {
    if (!opened) return;
    const frame = requestAnimationFrame(() => (panel.current?.querySelector<HTMLButtonElement>("button") ?? panel.current)?.focus());
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("keydown", escape, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", escape, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);
  useLayoutEffect(() => {
    if (opened || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [opened]);
  // The open box comes from the room measured at the click; the observed panel height (capped by the room) fills in the content fit.
  const size = opened ? { width: room.width, height: Math.min(panelSize?.height ?? room.height, room.height) } : pillSize;
  return (
    // Holds the pill's spot in the composer row; the surface hangs from its bottom-right corner.
    <PillSlot
      ref={root}
      slot={slot}
      still={opened && expanded}
      className={`relative shrink-0 ${className}`}
      style={pillSize ? { width: pillSize.width, height: pillSize.height } : undefined}
    >
      {/* One surface morphs between the pill and the panel; both faces stay mounted and crossfade over it. Closed, it is
      the row's frosted glass pill; open, a raised card. */}
      {opened && expanded && <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-overlay" aria-hidden />}
      <div
        data-slot={slot.replace(/-track$/, "-surface")}
        style={
          opened && expanded
            ? { position: "fixed", inset: 20, zIndex: 50, borderRadius: 10 }
            : size
              ? { width: size.width, height: size.height, [anchor]: opened ? -room.shift : 0, borderRadius: opened ? 10 : size.height / 2 }
              : undefined
        }
        className={`absolute bottom-0 z-10 overflow-hidden text-ink ${expanded ? "" : MORPH_SURFACE} ${opened ? "bg-surface shadow-raised" : `status-pill ${PILL_TONES[pill.tone ?? "ink"]}`}`}
      >
        <motion.div
          ref={(node: HTMLDivElement | null) => {
            panel.current = node;
            return measurePanel(node);
          }}
          id={panelId}
          // A dialog only while it is on show; the hidden face is inert and not one.
          role={opened ? "dialog" : undefined}
          aria-label={opened ? title : undefined}
          aria-modal={opened ? "false" : undefined}
          tabIndex={-1}
          data-slot={panelSlot}
          data-state={opened ? "open" : "closed"}
          {...morphFace(opened, reduce, scale)}
          data-expanded={(opened && expanded) || undefined}
          style={opened && expanded ? { inset: 0 } : fill ? { width: room.width, height: room.height } : { width: room.width, maxHeight: room.height }}
          className={`absolute ${side} bottom-0 flex flex-col bg-surface focus:outline-none ${opened ? "visible" : HIDDEN_FACE}`}
        >
          {typeof children === "function" ? children(() => close(true)) : children}
        </motion.div>
      </div>
      {/* The pill face sits over the surface at the pill's spot, so it never travels when the panel is moved right. */}
      <motion.div
        ref={measurePill}
        data-face="pill"
        {...morphFace(!opened, reduce, scale)}
        className={`absolute ${side} bottom-0 z-10 flex ${opened ? HIDDEN_FACE : "visible"}`}
      >
        <Tooltip label={tooltip} align={anchor === "left" ? "start" : "end"}>
          <StatusPill
            ref={trigger}
            bare
            aria-haspopup="dialog"
            aria-expanded={opened}
            aria-controls={panelId}
            onClick={() => {
              fit();
              onOpenChange(true);
            }}
            {...pill}
          />
        </Tooltip>
      </motion.div>
    </PillSlot>
  );
}

import { useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { setPanelResizing } from "../../lib/panel-resizing";
import { ArrowExpandDiagonal01Icon, Attachment01Icon, ArrowUp02Icon, Cancel01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { RoutineChip } from "../routines/RoutineChip";
import { useControlsClearance } from "../../lib/window-chrome";
import { IconButton } from "../primitives/Button";
import { PROMPT_PLACEHOLDER } from "@milagre/shared/prompt-mentions";
import { Icon } from "../primitives/Icon";
import { CORNER_PITCH } from "./PanelToggles";
import { TileTitle, type TileMenuControls } from "./TileFamilyMenu";

/** A split pane header's hairline; the first pane's fades in from the sidebar. */
function SplitRule({ first }: { first: boolean }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-line"
      style={first ? { background: "linear-gradient(90deg, transparent, var(--line) 96px)" } : undefined}
    />
  );
}

/** An unfocused split pane's composer, drawn like the real one: a press focuses the pane, which brings its full composer with the draft. */
export function SplitReply({ title, running, onReply, onStop }: { title: string; running: boolean; onReply: () => void; onStop: () => void }) {
  return (
    <div data-split-reply className="chat-gutter mx-auto w-full max-w-[var(--chat-width)] shrink-0 p-1.5">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Reply to ${title}`}
        onClick={(event) => {
          event.stopPropagation();
          onReply();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onReply();
        }}
        className="promptbar-surface flex cursor-text flex-col gap-2 rounded-window border border-line p-3 focus-visible:outline-2"
      >
        <span className="line-clamp-3 min-h-[68px] px-2 py-2 text-[length:calc(var(--chat-size)+1px)] leading-5 text-ink-3">{PROMPT_PLACEHOLDER}</span>
        <span className="flex items-center justify-between">
          <span className="flex size-7 items-center justify-center text-ink-3">
            <Icon icon={Attachment01Icon} size={16} />
          </span>
          {running ? (
            <button
              type="button"
              aria-label="Stop agent"
              data-split-reply-stop
              onClick={(event) => {
                event.stopPropagation();
                onStop();
              }}
              className="flex size-7 items-center justify-center rounded-full bg-ink text-on-ink transition-opacity hover:opacity-90"
            >
              <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="block">
                <rect width="10" height="10" rx="2" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <span className="flex size-7 items-center justify-center rounded-full bg-ink text-on-ink opacity-40">
              <Icon icon={ArrowUp02Icon} size={16} />
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/** A split pane's header, in the title bar: the Chat's name and its menu, then the panel menu, Open alone and close. */
export function SplitHeader({
  chatKey,
  title,
  focused,
  first,
  top,
  tiles,
  menu,
  panelMenu,
  needsYou,
  waitingBelow,
  onFocus,
  routine,
  onOpenRoutine,
  onClose,
}: {
  chatKey: string;
  title: string;
  focused: boolean;
  first: boolean;
  /** The column's top pane, whose header sits in the title bar row; the one under it has its own header row. */
  top: boolean;
  tiles: readonly string[];
  menu?: TileMenuControls;
  panelMenu?: ReactNode;
  needsYou: boolean;
  waitingBelow: number;
  onFocus: (key: string) => void;
  routine?: { routineId: string };
  onOpenRoutine?: (routineId: string) => void;
  onClose?: (key: string) => void;
}) {
  const { bar, inset } = useControlsClearance<HTMLElement>(top, CORNER_PITCH);
  return (
    <header
      ref={bar}
      data-split-header
      style={{ paddingLeft: inset.paddingLeft + 12, paddingRight: inset.paddingRight + 8 }}
      className={`relative flex h-[var(--window-chrome-height)] shrink-0 items-center gap-2 text-13 ${top ? "title-drag z-[55]" : ""}`}
    >
      <SplitRule first={first} />
      <span className="no-drag flex min-w-0 shrink items-center">
        {menu ? (
          <TileTitle chatKey={chatKey} title={title} tiles={tiles} controls={menu} />
        ) : (
          <span className="min-w-0 truncate font-medium text-ink">{title}</span>
        )}
      </span>
      <span className="flex-1" />
      {onOpenRoutine && <RoutineChip chatKey={chatKey} run={routine} place="tile" onOpen={onOpenRoutine} />}
      {needsYou && !focused && <span className="shrink-0 font-medium text-orange-ink">Needs you</span>}
      {waitingBelow > 0 && !focused && (
        <span data-tile-waiting className="shrink-0 font-medium text-orange-ink">
          {waitingBelow} {waitingBelow === 1 ? "needs" : "need"} you
        </span>
      )}
      <span
        style={{ right: inset.paddingRight }}
        className="no-drag absolute top-0 bottom-px flex items-center gap-0.5 bg-[linear-gradient(90deg,transparent,var(--page)_24px)] pr-2 pl-8 opacity-0 transition-opacity duration-fast group-hover/tile:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100"
      >
        {focused ? (
          panelMenu
        ) : (
          <IconButton label="Panels" icon={MoreHorizontalIcon} size={24} side="bottom" data-split-panels-focus onClick={() => onFocus(chatKey)} />
        )}
        {menu && (
          <IconButton
            label="Open alone"
            icon={ArrowExpandDiagonal01Icon}
            size={24}
            side="bottom"
            data-tile-open-alone-button
            onClick={(event) => {
              event.stopPropagation();
              menu.onOpenAlone(chatKey);
            }}
          />
        )}
        <IconButton
          label="Close"
          icon={Cancel01Icon}
          size={24}
          side="bottom"
          data-tile-close
          onClick={(event) => {
            event.stopPropagation();
            onClose?.(chatKey);
          }}
        />
      </span>
    </header>
  );
}

/**
 * The hairline between two split panes, a column's pair or a stacked pair, that drags the share the first one takes.
 * `onShare` follows the pointer once a frame and gets `commit` when the drag, a key or a double-click back to even ends.
 */
export function SplitDivider({
  axis,
  label,
  min,
  fade = false,
  style,
  measure,
  onShare,
}: {
  axis: "x" | "y";
  label: string;
  min: number;
  fade?: boolean;
  /** Where the seam sits in the split. */
  style: CSSProperties;
  /** The pair's sizes along the axis, in pixels: the first pane's and both together. */
  measure: () => { first: number; total: number } | null;
  onShare: (share: number, commit: boolean) => void;
}) {
  const [resizing, setResizing] = useState(false);
  const [share, setShare] = useState(0.5);
  const across = axis === "x";
  const clampShare = (first: number, total: number) => Math.min(total - min, Math.max(min, first)) / total;
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const sizes = measure();
    if (!sizes || sizes.total < min * 2) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const origin = across ? event.clientX : event.clientY;
    let latest = sizes.first / sizes.total;
    setResizing(true);
    setPanelResizing(true);
    document.body.style.cursor = across ? "col-resize" : "row-resize";
    let frame = 0;
    const at = (pointer: PointerEvent) => clampShare(sizes.first + (across ? pointer.clientX : pointer.clientY) - origin, sizes.total);
    const move = (pointer: PointerEvent) => {
      latest = at(pointer);
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        onShare(latest, false);
      });
    };
    const end = (pointer: PointerEvent) => {
      if (pointer.type === "pointerup") latest = at(pointer);
      cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.style.cursor = "";
      setResizing(false);
      setShare(latest);
      onShare(latest, true);
      setPanelResizing(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const sizes = measure();
    if (!sizes) return;
    const step = event.shiftKey ? 48 : 16;
    const back = across ? "ArrowLeft" : "ArrowUp";
    const forward = across ? "ArrowRight" : "ArrowDown";
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    const next = clampShare(sizes.first + (event.key === back ? -step : step), sizes.total);
    setShare(next);
    onShare(next, true);
  };
  return (
    <div
      data-split-divider={across ? "column" : "row"}
      className={`absolute bg-line ${across ? "z-20 w-px" : "z-10 h-px"}`}
      style={fade ? { ...style, background: "linear-gradient(90deg, transparent, var(--line) 96px)" } : style}
    >
      <div
        role="separator"
        aria-orientation={across ? "vertical" : "horizontal"}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        onPointerDown={start}
        onDoubleClick={() => {
          setShare(0.5);
          onShare(0.5, true);
        }}
        onKeyDown={keys}
        className={`no-drag group absolute z-10 flex justify-center outline-none ${
          across ? "inset-y-0 -left-1.5 w-3 cursor-col-resize" : "inset-x-0 -top-1.5 h-3 cursor-row-resize flex-col"
        }`}
      >
        <span
          className={`rounded-full transition-colors group-hover:bg-line-strong group-focus-visible:bg-accent ${across ? "w-0.5" : "h-0.5"} ${
            resizing ? "bg-line-strong" : "bg-transparent"
          }`}
        />
      </div>
    </div>
  );
}

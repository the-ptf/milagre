import {
  cloneElement,
  createContext,
  isValidElement,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefCallback,
} from "react";
import { createPortal } from "react-dom";
import { openModal } from "../../lib/modal";
import { shortcutModifier, useShortcutHints } from "../../lib/shortcut-hints";
import { ShortcutKeys } from "./ShortcutKeys";

export const TOOLTIP_SHOW_DELAY = 400;

/** Set inside a Tooltip, so an IconButton in it doesn't add a second one. */
export const InTooltip = createContext(false);

/** Where a trigger's floating layers go: an open modal dialog or a popover host sits above body, so they go into it. */
export const layerHost = (trigger: Element | null | undefined) => trigger?.closest("dialog, [data-popover-host]") ?? document.body;

/** Shared tooltip presentation for ordinary triggers and text hit-tested under a native input. */
export function TooltipBubble({
  label,
  rect,
  align = "start",
  side = "top",
  wrap = false,
  hint,
  host,
}: {
  label: string;
  rect: DOMRect;
  align?: "start" | "end";
  side?: "top" | "bottom";
  wrap?: boolean;
  hint?: string;
  /** The element the bubble portals into; body by default. */
  host?: Element | null;
}) {
  return createPortal(
    <span
      role="tooltip"
      className={`pointer-events-none fixed z-[60] flex items-center gap-2 ${wrap ? "max-w-[280px] whitespace-normal leading-snug" : "whitespace-nowrap"} rounded-chip bg-ink px-2 py-1 text-12 font-medium text-on-ink shadow-overlay`}
      style={{
        ...(side === "top" ? { top: rect.top - 6 } : { top: rect.bottom + 6 }),
        ...(align === "start" ? { left: rect.left } : { right: window.innerWidth - rect.right }),
        transform: side === "top" ? "translateY(-100%)" : undefined,
        animation: "fade-in var(--duration-fast) var(--ease-enter) both",
      }}
    >
      {label}
      {hint && <ShortcutKeys shortcut={hint} plain className="text-ink-4" />}
    </span>,
    host ?? document.body,
  );
}

export type TooltipOptions = {
  label: string;
  shortcut?: string;
  /** A key pressed on its own, without ⌘ (the canvas's C): shown in the tooltip, not with the hints holding ⌘ shows. */
  keyHint?: string;
  align?: "start" | "end";
  /** Which side of the trigger the tooltip opens on; "bottom" for triggers at the window's top edge. */
  side?: "top" | "bottom";
  /** Lets a long label break onto more lines instead of running past the window. */
  wrap?: boolean;
  /** For a row of icon buttons too close for full hints: smaller keys, just under its button instead of over it. */
  compactHint?: boolean;
};

/** Sets every ref it's given; React 19 refs are props, so a child's own ref goes through here too. */
export function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    }
  };
}

/**
 * The tooltip's state for one trigger: the handlers and ref to put on it, and the layers to render beside it (the
 * bubble, the shortcut hint). `enabled: false` keeps the hook order and does nothing. Escape hides an open tooltip
 * until the next pointer enter or focus (WCAG 1.4.13).
 */
export function useTooltip({ label, shortcut, keyHint, align = "start", side = "top", wrap = false, compactHint = false }: TooltipOptions, enabled = true) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  // Read when the bubble or the hint shows, not on mount: no extra render for every icon button.
  const hostRef = useRef<Element | null>(null);
  const showHints = useShortcutHints();
  const [hintRect, setHintRect] = useState<DOMRect | null>(null);
  const hintRef = useRef<HTMLElement>(null);
  const hint = (shortcut ?? keyHint)?.replace("⌘", shortcutModifier);
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    hostRef.current = layerHost(trigger);
    const modal = openModal();
    const bounds = trigger?.getBoundingClientRect();
    setHintRect(enabled && showHints && shortcut && bounds?.width && bounds.height && (!modal || modal.contains(trigger)) ? bounds : null);
  }, [enabled, showHints, shortcut]);
  useLayoutEffect(() => {
    const badge = hintRef.current;
    if (!badge || !hintRect) return;
    const half = badge.getBoundingClientRect().width / 2;
    const anchor = hintRect.width > 80 ? hintRect.right - 22 : hintRect.left + hintRect.width / 2;
    badge.style.left = `${Math.max(8 + half, Math.min(window.innerWidth - 8 - half, anchor))}px`;
  }, [hintRect, hint, rect]);

  const clear = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const show = (delay: number) => {
    if (!enabled) return;
    clear();
    timerRef.current = window.setTimeout(() => {
      hostRef.current = layerHost(triggerRef.current);
      setRect(triggerRef.current?.getBoundingClientRect() ?? null);
    }, delay);
  };
  const hide = () => {
    clear();
    setRect(null);
  };

  useEffect(() => clear, []);
  useEffect(() => {
    if (!rect) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [rect]);

  return {
    ref: triggerRef,
    handlers: {
      onPointerEnter: () => show(TOOLTIP_SHOW_DELAY),
      onPointerLeave: hide,
      onPointerDown: hide,
      onFocus: (event: FocusEvent<HTMLElement>) => {
        if (event.target.matches(":focus-visible")) show(0);
      },
      onBlur: hide,
    },
    layers: enabled ? (
      <>
        {rect && <TooltipBubble label={label} rect={rect} align={align} side={side} wrap={wrap} hint={hint} host={hostRef.current} />}
        {hintRect &&
          !rect &&
          createPortal(
            <ShortcutKeys
              ref={hintRef}
              shortcut={hint!}
              compact={compactHint}
              aria-hidden="true"
              className="pointer-events-none fixed z-[70]"
              style={{
                top: compactHint ? hintRect.bottom + 12 : hintRect.top + hintRect.height / 2,
                left: hintRect.width > 80 ? hintRect.right - 22 : hintRect.left + hintRect.width / 2,
                transform: "translate(-50%, -50%)",
              }}
            />,
            hostRef.current ?? document.body,
          )}
      </>
    ) : null,
  };
}

type Handlers = ReturnType<typeof useTooltip>["handlers"];
// `label` is IconButton's name prop.
type ChildProps = Partial<Handlers> & { ref?: Ref<HTMLElement>; label?: string; "aria-label"?: string; "aria-description"?: string; children?: ReactNode };

/** Calls the trigger's own handler, then the tooltip's. */
export function chainHandlers(child: Partial<Record<keyof Handlers, unknown>>, handlers: Handlers): Handlers {
  return Object.fromEntries(
    (Object.keys(handlers) as (keyof Handlers)[]).map((key) => [
      key,
      (event: never) => {
        (child[key] as ((event: never) => void) | undefined)?.(event);
        (handlers[key] as (event: never) => void)(event);
      },
    ]),
  ) as Handlers;
}

/** The trigger's accessible name, roughly: its aria-label, or its text. */
const nameOf = (element: Element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";

/**
 * The app's ink tooltip. By default it wraps its children in an inline-flex span; `asChild` puts the handlers and ref
 * on the single child element instead, with no wrapper (a `> button` selector, a truncating link, a motion element).
 * When the label isn't already the trigger's name it's also its `aria-description`, so a disabled reason is read out
 * (an attribute rather than aria-describedby, so no hidden text lands in the page's textContent). It portals into an
 * open dialog or `[data-popover-host]` around the trigger.
 */
export default function Tooltip({
  asChild = false,
  className = "",
  children,
  ...options
}: TooltipOptions & {
  /** Attach to the one child element instead of wrapping it. */
  asChild?: boolean;
  /** Extra classes for the trigger wrapper, e.g. to position it (not used with asChild). */
  className?: string;
  children: ReactNode;
}) {
  const { ref, handlers, layers } = useTooltip(options);
  const wrapper = useRef<HTMLSpanElement>(null);
  // Wrapped: describe the first child from the DOM, since its name is only known once rendered.
  useLayoutEffect(() => {
    const target = wrapper.current?.firstElementChild;
    if (!target || target.hasAttribute("aria-description") || nameOf(target) === options.label) return;
    target.setAttribute("aria-description", options.label);
    return () => target.removeAttribute("aria-description");
  }, [options.label]);

  if (asChild && isValidElement<ChildProps>(children)) {
    const own = children.props;
    const describe = ![own["aria-label"], own.label, own.children].includes(options.label);
    return (
      <InTooltip value>
        {cloneElement(children as ReactElement<ChildProps>, {
          ...chainHandlers(own, handlers),
          ref: mergeRefs(own.ref, ref),
          "aria-description": own["aria-description"] ?? (describe ? options.label : undefined),
        })}
        {layers}
      </InTooltip>
    );
  }
  return (
    <span ref={mergeRefs(wrapper, ref)} className={`inline-flex ${className}`} {...handlers}>
      <InTooltip value>{children}</InTooltip>
      {layers}
    </span>
  );
}

/** For a component that renders its own trigger: whether a Tooltip around it already shows one. */
export const useInTooltip = () => use(InTooltip);

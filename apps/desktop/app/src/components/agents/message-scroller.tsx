import { useReducedMotion } from "motion/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { type ComponentPropsWithRef, type Ref, createContext, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PreviewRail, type PreviewRailItem } from "../motion/PreviewRail";
import { Icon } from "../primitives/Icon";
import { messageNavigationIndices } from "@milagre/shared/message-navigation";
import { onPanelResizeEnd, panelResizing } from "../../lib/panel-resizing";

const PREVIEW_TITLE_LENGTH = 56;
const PREVIEW_DESCRIPTION_LENGTH = 88;
const LIVE_TAIL = 3;
const RAIL_REFRESH_MS = 250;

function truncateMessageText(text: string, limit: number) {
  if (text.length <= limit) return text;
  const excerpt = text.slice(0, limit);
  const boundary = excerpt.lastIndexOf(" ");
  return `${excerpt.slice(0, boundary > limit * 0.65 ? boundary : limit).trim()}…`;
}

function getMessageText(message: HTMLElement) {
  const surface =
    message.querySelector<HTMLElement>('[data-slot="message-bubble-content"]') ??
    message.querySelector<HTMLElement>('[data-slot="message-content"]') ??
    message;
  if (surface !== message) return (surface.textContent ?? "").replace(/\s+/g, " ").trim();
  const walker = document.createTreeWalker(message, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node instanceof Element ? (node.matches('[data-slot="activity-body"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT,
  });
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) text += node.textContent ?? "";
  return text.replace(/\s+/g, " ").trim();
}

function getMessagePreview(message: HTMLElement, assistantResponse?: HTMLElement) {
  const text = getMessageText(message);
  if (!text) return { label: "Message", description: undefined };

  const responseText = assistantResponse ? getMessageText(assistantResponse) : "";
  if (text.length <= PREVIEW_TITLE_LENGTH) {
    return {
      label: text,
      description: responseText ? truncateMessageText(responseText, PREVIEW_DESCRIPTION_LENGTH) : undefined,
    };
  }

  const titleExcerpt = text.slice(0, PREVIEW_TITLE_LENGTH);
  const titleBoundary = titleExcerpt.lastIndexOf(" ");
  const titleEnd = titleBoundary > PREVIEW_TITLE_LENGTH * 0.65 ? titleBoundary : PREVIEW_TITLE_LENGTH;

  return {
    label: `${text.slice(0, titleEnd).trim()}…`,
    description: truncateMessageText(responseText || text.slice(titleEnd).trim(), PREVIEW_DESCRIPTION_LENGTH),
  };
}

export interface MessageScrollerProps extends ComponentPropsWithRef<"div"> {
  followOutput?: boolean;
  followThreshold?: number;
  smooth?: boolean;
  onFollowChange?: (following: boolean) => void;
  label?: string;
  busy?: boolean;
  navigation?: "rail" | "none";
  navigationLabel?: string;
  viewportClassName?: string;
  contentClassName?: string;
  railClassName?: string;
  viewportRef?: Ref<HTMLElement>;
  viewportProps?: Omit<ComponentPropsWithRef<"section">, "children" | "className" | "ref">;
  contentProps?: Omit<ComponentPropsWithRef<"div">, "children" | "className" | "ref">;
  autoScrollKey?: string | number;
  onJumpToBottomChange?: (jump: (() => void) | null) => void;
  onAtEndChange?: (atEnd: boolean) => void;
}

const END_SLACK = 16;

export const MessageFollowContext = createContext<{ readonly current: boolean } | null>(null);

export const TRANSCRIPT_SHOWN_EVENT = "milagre:transcript-shown";
/**
 * Dispatched on the viewport to show a transcript at its latest message and follow it from there. Code outside the
 * scroller never writes `scrollTop` to reach the end: the browser fires the scroll event for that write a frame later,
 * after messages that were still measuring have grown, and the scroller would read it as the reader scrolling away.
 */
export const TRANSCRIPT_END_EVENT = "milagre:transcript-end";

/** A nested output/table owns the gesture while it can scroll, or when it prevents scroll chaining. */
function scrollsInside(target: EventTarget | null, viewport: HTMLElement, direction: number) {
  for (let node = target instanceof Element ? target : null; node && node !== viewport; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!/(auto|scroll)/.test(style.overflowY)) continue;
    if (style.overscrollBehaviorY !== "auto") return true;
    if (direction < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
  }
  return false;
}

export function MessageScroller({
  followOutput = true,
  followThreshold = 56,
  smooth = true,
  onFollowChange,
  label = "Conversation",
  busy,
  navigation = "rail",
  navigationLabel = "Message navigation",
  viewportClassName = "",
  contentClassName = "",
  railClassName = "",
  viewportRef: externalViewportRef,
  viewportProps,
  contentProps,
  className = "",
  children,
  autoScrollKey,
  onJumpToBottomChange,
  onAtEndChange,
  ...props
}: MessageScrollerProps) {
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(followOutput);
  const programmaticScrollRef = useRef(false);
  const readingRef = useRef(false);
  const inputDirectionRef = useRef(0);
  const previousTopRef = useRef(0);
  const touchYRef = useRef<number | undefined>(undefined);
  const scrollTimerRef = useRef<number | undefined>(undefined);
  const scrollSettleFrameRef = useRef<number | undefined>(undefined);
  const railFrameRef = useRef<number | undefined>(undefined);
  const railRefreshTimerRef = useRef<number | undefined>(undefined);
  const activeFrameRef = useRef<number | undefined>(undefined);
  const previewCacheRef = useRef(new WeakMap<HTMLElement, { label: string; description: string | undefined }>());
  const railMessageCountRef = useRef(0);
  const railIdRef = useRef(new WeakMap<HTMLElement, string>());
  const railIdCounterRef = useRef(0);
  const railTargetsRef = useRef(new Map<string, HTMLElement>());
  const [railItems, setRailItems] = useState<PreviewRailItem[]>([]);
  const [activeRailId, setActiveRailId] = useState("");
  const [railOverflowing, setRailOverflowing] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [measuring, setMeasuring] = useState(true);
  const {
    onScroll: onViewportScroll,
    onWheel: onViewportWheel,
    onTouchStart: onViewportTouchStart,
    onTouchMove: onViewportTouchMove,
    onKeyDown: onViewportKeyDown,
    ...restViewportProps
  } = viewportProps ?? {};

  const setViewportRef = useCallback(
    (node: HTMLElement | null) => {
      viewportRef.current = node;
      if (typeof externalViewportRef === "function") {
        externalViewportRef(node);
      } else if (externalViewportRef) {
        // oxlint-disable-next-line react/immutability -- React Compiler heuristic: the ref or handler is assigned or called after render, not during it
        externalViewportRef.current = node;
      }
    },
    [externalViewportRef],
  );

  const setFollowing = useCallback(
    (next: boolean) => {
      if (next) readingRef.current = false;
      if (followingRef.current === next) return;
      followingRef.current = next;
      onFollowChange?.(next);
    },
    [onFollowChange],
  );

  const updateActiveRailItem = useCallback(() => {
    if (navigation !== "rail") return;
    const viewport = viewportRef.current;
    const targets = [...railTargetsRef.current.entries()];
    const first = targets[0];
    if (!viewport) return;
    if (!first) {
      setActiveRailId("");
      return;
    }

    if (viewport.scrollTop <= followThreshold) {
      setActiveRailId((current) => (current === first[0] ? current : first[0]));
      return;
    }

    const distanceFromEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromEnd <= followThreshold) {
      const lastId = targets.at(-1)?.[0] ?? "";
      setActiveRailId((current) => (current === lastId ? current : lastId));
      return;
    }

    const viewportCenter = viewport.getBoundingClientRect().top + viewport.clientHeight / 2;
    const centerOf = (index: number) => {
      const target = targets[index];
      if (!target) return undefined;
      const rect = target[1].getBoundingClientRect();
      return rect.top + rect.height / 2;
    };
    let low = 0;
    let high = targets.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      const center = centerOf(mid);
      if (center === undefined) return;
      if (center < viewportCenter) low = mid + 1;
      else high = mid;
    }
    const previous = low > 0 ? low - 1 : low;
    const previousCenter = centerOf(previous);
    const lowCenter = centerOf(low);
    if (previousCenter === undefined || lowCenter === undefined) return;
    const nearest = Math.abs(previousCenter - viewportCenter) <= Math.abs(lowCenter - viewportCenter) ? previous : low;
    const target = targets[nearest];
    if (!target) return;
    const nearestId = target[0];

    setActiveRailId((current) => (current === nearestId ? current : nearestId));
  }, [followThreshold, navigation]);

  const syncRailItems = useCallback(() => {
    if (navigation !== "rail") return;
    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!content || !viewport) return;

    const messages = Array.from(content.querySelectorAll<HTMLElement>('[data-slot="message"]'));
    // oxlint-disable-next-line unicorn/no-new-array -- array is pre-sized and filled by index on purpose
    const responses: Array<HTMLElement | undefined> = new Array(messages.length);
    let nextAssistant: HTMLElement | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      responses[index] = nextAssistant;
      const message = messages[index];
      if (message?.dataset.from === "assistant") nextAssistant = message;
    }
    const cache = previewCacheRef.current;
    const targets = new Map<string, HTMLElement>();
    const nextItems = messageNavigationIndices(messages.length).flatMap((index) => {
      const message = messages[index];
      if (!message) return [];
      let id = railIdRef.current.get(message);
      if (!id) {
        railIdCounterRef.current += 1;
        id = `message-rail-${railIdCounterRef.current}-${index}`;
        railIdRef.current.set(message, id);
      }
      targets.set(id, message);
      const sender = message.dataset.from ?? "conversation";
      let preview = cache.get(message);
      if (!preview) {
        preview = getMessagePreview(message, sender === "user" ? responses[index] : undefined);
        if (index < messages.length - LIVE_TAIL) cache.set(message, preview);
      }

      return [
        {
          id,
          label: preview.label,
          description: preview.description,
          ariaLabel: `Go to ${sender} message ${index + 1} of ${messages.length}`,
        },
      ];
    });
    railMessageCountRef.current = messages.length;

    railTargetsRef.current = targets;
    setRailItems((current) => {
      const unchanged =
        current.length === nextItems.length &&
        current.every(
          (item, index) =>
            item.id === nextItems[index]?.id &&
            item.label === nextItems[index]?.label &&
            item.description === nextItems[index]?.description &&
            item.ariaLabel === nextItems[index]?.ariaLabel,
        );
      return unchanged ? current : nextItems;
    });
    setRailOverflowing(viewport.scrollHeight > viewport.clientHeight + 1 && messages.length > 1);
  }, [navigation]);

  const scheduleActiveRailItem = useCallback(() => {
    if (navigation !== "rail" || activeFrameRef.current) return;
    activeFrameRef.current = requestAnimationFrame(() => {
      activeFrameRef.current = undefined;
      updateActiveRailItem();
    });
  }, [navigation, updateActiveRailItem]);

  const scheduleRailSync = useCallback(() => {
    if (navigation !== "rail") return;
    if (railFrameRef.current) cancelAnimationFrame(railFrameRef.current);
    railFrameRef.current = requestAnimationFrame(() => {
      syncRailItems();
      updateActiveRailItem();
    });
  }, [navigation, syncRailItems, updateActiveRailItem]);

  const scheduleRailRefresh = useCallback(() => {
    if (navigation !== "rail" || railRefreshTimerRef.current) return;
    railRefreshTimerRef.current = window.setTimeout(() => {
      railRefreshTimerRef.current = undefined;
      syncRailItems();
    }, RAIL_REFRESH_MS);
  }, [navigation, syncRailItems]);

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    programmaticScrollRef.current = true;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = undefined;
    if (scrollSettleFrameRef.current) cancelAnimationFrame(scrollSettleFrameRef.current);
    scrollSettleFrameRef.current = requestAnimationFrame(() => {
      scrollSettleFrameRef.current = undefined;
      if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1) programmaticScrollRef.current = false;
    });
  }, []);

  const atEndRef = useRef<boolean | null>(null);
  const atEndChangeRef = useRef(onAtEndChange);
  useEffect(() => {
    atEndChangeRef.current = onAtEndChange;
  }, [onAtEndChange]);
  const updateJumpToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setShowJumpToBottom(distance > followThreshold);
    const atEnd = distance <= END_SLACK;
    if (atEndRef.current === atEnd) return;
    atEndRef.current = atEnd;
    atEndChangeRef.current?.(atEnd);
  }, [followThreshold]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const previousTop = previousTopRef.current;
    previousTopRef.current = viewport.scrollTop;
    scheduleActiveRailItem();
    updateJumpToBottom();
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (programmaticScrollRef.current) {
      if (distance <= 1) programmaticScrollRef.current = false;
      return;
    }
    if (readingRef.current) {
      // Only a downward gesture reaching the actual end resumes following, not growth within 56px of it.
      if (inputDirectionRef.current > 0 && viewport.scrollTop > previousTop && distance <= 1) setFollowing(true);
      return;
    }
    setFollowing(distance <= followThreshold);
  }, [followThreshold, scheduleActiveRailItem, setFollowing, updateJumpToBottom]);

  const manualScroll = useCallback(
    (direction: number, target: EventTarget | null) => {
      const viewport = viewportRef.current;
      if (!viewport || !direction || scrollsInside(target, viewport, direction)) return;
      inputDirectionRef.current = direction;
      if (direction < 0) {
        readingRef.current = true;
        setFollowing(false);
      }
      const wasProgrammatic = programmaticScrollRef.current;
      programmaticScrollRef.current = false;
      if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
      if (scrollSettleFrameRef.current) cancelAnimationFrame(scrollSettleFrameRef.current);
      // Cancel a smooth jump before the browser applies this wheel/key/touch gesture.
      if (wasProgrammatic) viewport.scrollTo({ top: viewport.scrollTop, behavior: "instant" });
    },
    [setFollowing],
  );

  const [measurePass, setMeasurePass] = useState(0);
  const shownBefore = useRef(false);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const remeasure = () => {
      setMeasuring(true);
      setMeasurePass((pass) => pass + 1);
    };
    viewport.addEventListener(TRANSCRIPT_SHOWN_EVENT, remeasure);
    if (shownBefore.current) remeasure();
    shownBefore.current = true;
    return () => viewport.removeEventListener(TRANSCRIPT_SHOWN_EVENT, remeasure);
  }, []);
  // messages that measure right after, and the ResizeObserver keeps the end in view as they do. Listening from the
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followOutput) return;
    const showEnd = () => {
      setFollowing(true);
      scrollToEnd("instant");
      updateJumpToBottom();
    };
    viewport.addEventListener(TRANSCRIPT_END_EVENT, showEnd);
    return () => viewport.removeEventListener(TRANSCRIPT_END_EVENT, showEnd);
  }, [followOutput, scrollToEnd, setFollowing, updateJumpToBottom]);
  useEffect(() => {
    let settle = 0;
    const first = requestAnimationFrame(() => {
      settle = requestAnimationFrame(() => setMeasuring(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(settle);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each pass runs the settle frames again
  }, [measurePass]);

  useLayoutEffect(() => {
    followingRef.current = followOutput;
    if (followOutput) scrollToEnd("instant");
    updateJumpToBottom();
  }, [followOutput, scrollToEnd, updateJumpToBottom]);

  useEffect(() => {
    if (!followOutput || !followingRef.current) return;
    scrollToEnd(reduce || !smooth ? "auto" : "smooth");
  }, [autoScrollKey, followOutput, reduce, scrollToEnd, smooth]);

  useEffect(() => {
    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!content || !viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followOutput && followingRef.current) scrollToEnd("instant");
      updateJumpToBottom();
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [followOutput, scrollToEnd, updateJumpToBottom]);

  useEffect(() => {
    if (navigation !== "rail") {
      railTargetsRef.current.clear();
      setRailItems([]);
      setRailOverflowing(false);
      return;
    }

    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!content || !viewport) return;

    scheduleRailSync();
    const listOf = () =>
      content.querySelector<HTMLElement>('[data-slot="message"]')?.parentElement ?? (content.firstElementChild as HTMLElement | null) ?? content;
    let list = listOf();
    const mutationObserver = new MutationObserver(() => {
      const current = listOf();
      if (current !== list) {
        mutationObserver.disconnect();
        list = current;
        mutationObserver.observe(content, { childList: true });
        if (list !== content) mutationObserver.observe(list, { childList: true });
      }
      scheduleRailSync();
    });
    mutationObserver.observe(content, { childList: true });
    if (list !== content) mutationObserver.observe(list, { childList: true });
    let rebuildAfterDrag = false;
    const resizeObserver = new ResizeObserver((entries) => {
      if (panelResizing()) rebuildAfterDrag = true;
      else {
        if (entries.some((entry) => entry.target === viewport)) scheduleRailSync();
        scheduleRailRefresh();
      }
      setRailOverflowing(viewport.scrollHeight > viewport.clientHeight + 1 && railMessageCountRef.current > 1);
      scheduleActiveRailItem();
    });
    resizeObserver.observe(content);
    resizeObserver.observe(viewport);
    const offDragEnd = onPanelResizeEnd(() => {
      if (!rebuildAfterDrag) return;
      rebuildAfterDrag = false;
      scheduleRailSync();
    });

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      offDragEnd();
    };
  }, [navigation, scheduleActiveRailItem, scheduleRailRefresh, scheduleRailSync]);

  useEffect(
    () => () => {
      if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
      if (scrollSettleFrameRef.current) cancelAnimationFrame(scrollSettleFrameRef.current);
      if (railFrameRef.current) cancelAnimationFrame(railFrameRef.current);
      if (activeFrameRef.current) cancelAnimationFrame(activeFrameRef.current);
      if (railRefreshTimerRef.current) window.clearTimeout(railRefreshTimerRef.current);
    },
    [],
  );

  const scrollToRailItem = useCallback(
    (item: PreviewRailItem) => {
      const viewport = viewportRef.current;
      const target = railTargetsRef.current.get(item.id);
      if (!viewport || !target || !contentRef.current?.contains(target)) return;

      const lastItem = railItems.at(-1)?.id === item.id;
      setActiveRailId(item.id);
      if (lastItem) {
        setFollowing(true);
        scrollToEnd(reduce || !smooth ? "auto" : "smooth");
        return;
      }

      setFollowing(false);
      programmaticScrollRef.current = true;
      const viewportRect = viewport.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const top = viewport.scrollTop + targetRect.top - viewportRect.top - (viewport.clientHeight - targetRect.height) / 2;
      const behavior = reduce || !smooth ? "auto" : "smooth";
      viewport.scrollTo({ top, behavior });
      if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = window.setTimeout(
        () => {
          programmaticScrollRef.current = false;
        },
        behavior === "smooth" ? 320 : 0,
      );
    },
    [railItems, reduce, scrollToEnd, setFollowing, smooth],
  );

  const jumpToBottom = useCallback(() => {
    setFollowing(true);
    scrollToEnd(reduce || !smooth ? "auto" : "smooth");
  }, [reduce, scrollToEnd, setFollowing, smooth]);
  const jumpChangeRef = useRef(onJumpToBottomChange);
  useLayoutEffect(() => {
    jumpChangeRef.current = onJumpToBottomChange;
  });
  const ownsJump = onJumpToBottomChange !== undefined;
  useEffect(() => {
    jumpChangeRef.current?.(showJumpToBottom ? jumpToBottom : null);
  }, [showJumpToBottom, jumpToBottom]);
  useEffect(() => () => jumpChangeRef.current?.(null), []);

  const viewport = (
    <section
      ref={setViewportRef}
      aria-label={label}
      {...restViewportProps}
      onScroll={(event) => {
        handleScroll();
        onViewportScroll?.(event);
      }}
      onWheel={(event) => {
        onViewportWheel?.(event);
        if (!event.defaultPrevented && !event.ctrlKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) manualScroll(event.deltaY, event.target);
      }}
      onTouchStart={(event) => {
        touchYRef.current = event.touches[0]?.clientY;
        onViewportTouchStart?.(event);
      }}
      onTouchMove={(event) => {
        onViewportTouchMove?.(event);
        const y = event.touches[0]?.clientY;
        if (!event.defaultPrevented && y !== undefined && touchYRef.current !== undefined) manualScroll(touchYRef.current - y, event.target);
        touchYRef.current = y;
      }}
      onKeyDown={(event) => {
        onViewportKeyDown?.(event);
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
        if (
          event.target instanceof Element &&
          event.target.closest('input, textarea, select, button, a[href], [contenteditable="true"], [role="textbox"], [role="slider"]')
        )
          return;
        const direction =
          ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)
            ? -1
            : ["ArrowDown", "PageDown", "End", " "].includes(event.key)
              ? 1
              : 0;
        manualScroll(direction, event.target);
      }}
      className={`h-full min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain focus-visible:-outline-offset-2 [overflow-anchor:none] ${navigation === "rail" ? "message-scroller-viewport [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden" : "[scrollbar-gutter:stable]"} ${viewportClassName}`}
    >
      <div
        ref={contentRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={busy}
        data-measuring={measuring || undefined}
        className={contentClassName}
        {...contentProps}
      >
        <MessageFollowContext value={followingRef}>{children}</MessageFollowContext>
      </div>
    </section>
  );

  return (
    <div data-slot="message-scroller" className={`group/scroller relative min-h-0 ${className}`} {...props}>
      {navigation === "rail" ? (
        <PreviewRail
          items={railOverflowing ? railItems : []}
          label={navigationLabel}
          activeId={activeRailId}
          onItemSelect={scrollToRailItem}
          previewSide="after"
          highlightActive
          itemSize={14}
          className="h-full min-h-0 overflow-hidden"
          previewContainerClassName="right-3 left-16"
          previewClassName="mr-1 w-64 max-w-full"
          // The ticks stay out of the gutter at rest and come in while the pointer is over the transcript (or a tick has focus).
          railClassName={`transition-opacity duration-base ${railOverflowing ? "pointer-events-auto opacity-0 group-hover/scroller:opacity-100 focus-within:opacity-100" : "pointer-events-none opacity-0"} ${railClassName}`}
        >
          {viewport}
        </PreviewRail>
      ) : (
        viewport
      )}
      {showJumpToBottom && !ownsJump && (
        <div className="pointer-events-none absolute inset-x-0 bottom-12 z-20 flex justify-center">
          <button
            type="button"
            aria-label="Go to bottom"
            onClick={jumpToBottom}
            className="pointer-events-auto inline-flex size-10 items-center justify-center rounded-full bg-surface/60 text-ink shadow-overlay backdrop-blur-chip transition-[background-color,scale] duration-fast hover:bg-surface/80 active:scale-press"
          >
            <Icon icon={ArrowDown01Icon} size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

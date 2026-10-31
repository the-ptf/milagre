import { useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { type ComponentPropsWithRef, type Ref, createContext, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PreviewRail, type PreviewRailItem } from "../motion/PreviewRail";
import { messageNavigationIndices } from "@milagre/shared/message-navigation";
import { onPanelResizeEnd, panelResizing } from "../../lib/panel-resizing";

const PREVIEW_TITLE_LENGTH = 56;
const PREVIEW_DESCRIPTION_LENGTH = 88;
// The last messages can still be streaming, so only older ones keep a cached preview.
const LIVE_TAIL = 3;
// Streamed growth refreshes the live previews this often instead of on every chunk.
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
  // Answerless replies preview their summary, independent of which activity rows were opened.
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
  /** Compatibility with the previous local API. */
  autoScrollKey?: string | number;
}

/** Whether the scroller around a transcript follows its bottom now: read when it matters, so following renders nothing. */
export const MessageFollowContext = createContext<{ readonly current: boolean } | null>(null);

/** Dispatched on the viewport of a parked transcript that is back in the document and needs measuring again. */
export const TRANSCRIPT_SHOWN_EVENT = "milagre:transcript-shown";

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
  ...props
}: MessageScrollerProps) {
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(followOutput);
  const programmaticScrollRef = useRef(false);
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
  // A newly opened conversation lays out every message at its real size once, so the skipped ones keep that size
  // instead of a guess that would shift the scroll position after it opens at the bottom.
  const [measuring, setMeasuring] = useState(true);
  const {
    onScroll: onViewportScroll,
    onWheel: onViewportWheel,
    onTouchStart: onViewportTouchStart,
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

    // Messages sit in document order, so their centres only grow: binary-search the first one past the viewport centre.
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
    // The first assistant message after each one, found in a single backwards pass.
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
    // Sample the whole Chat, including both ends, rather than growing a tick per message.
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

  // Scroll events and layout changes ask for the active item at most once a frame.
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

  // Streamed growth: the last previews change but the list doesn't, so refresh them on a timer, not per chunk.
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
    // A correction at the end may produce no scroll event. Check after queued
    // layout and scroll events so later Find navigation can leave the live edge.
    scrollSettleFrameRef.current = requestAnimationFrame(() => {
      scrollSettleFrameRef.current = undefined;
      if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1) programmaticScrollRef.current = false;
    });
  }, []);

  const updateJumpToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setShowJumpToBottom(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > followThreshold);
  }, [followThreshold]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // The active item follows every scroll, including the ones that chase streamed output.
    scheduleActiveRailItem();
    updateJumpToBottom();
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    // Long jumps and image layout changes can outlast a fixed animation timer.
    // Keep following until the actual end is reached or user input interrupts the jump.
    if (programmaticScrollRef.current) {
      if (distance <= 1) programmaticScrollRef.current = false;
      return;
    }
    setFollowing(distance <= followThreshold);
  }, [followThreshold, scheduleActiveRailItem, setFollowing, updateJumpToBottom]);

  const leaveLiveEdge = useCallback(() => {
    programmaticScrollRef.current = false;
  }, []);

  // A parked transcript put back in the document (ChatComposer's TranscriptSlots) with messages whose size
  // contain-intrinsic-size never learned measures every message once more.
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
    // Effects run again when a hidden <Activity> shows this scroller again; display:none dropped the remembered sizes.
    if (shownBefore.current) remeasure();
    shownBefore.current = true;
    return () => viewport.removeEventListener(TRANSCRIPT_SHOWN_EVENT, remeasure);
  }, []);
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
    // Position a newly opened conversation before the browser can paint its top.
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
      // Images and skipped messages may change height several times. Correct the live edge
      // immediately instead of repeatedly restarting a smooth jump to an outdated height.
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
    // Only messages being added or removed rebuild the list; text streaming inside one never reaches this observer.
    // A list that doesn't exist yet (or is replaced) is found again through the content's own children.
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
    // While a panel edge is dragged the viewport resizes on every frame: the list is rebuilt once, when the drag ends.
    let rebuildAfterDrag = false;
    const resizeObserver = new ResizeObserver((entries) => {
      // A resized viewport can change what fits, so it rebuilds the list; content growth only checks overflow and the active item.
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
        leaveLiveEdge();
        onViewportWheel?.(event);
      }}
      onTouchStart={(event) => {
        leaveLiveEdge();
        onViewportTouchStart?.(event);
      }}
      onKeyDown={(event) => {
        if (["ArrowUp", "PageUp", "Home"].includes(event.key)) leaveLiveEdge();
        onViewportKeyDown?.(event);
      }}
      className={`h-full min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] ${navigation === "rail" ? "message-scroller-viewport [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden" : "[scrollbar-gutter:stable]"} ${viewportClassName}`}
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
    <div data-slot="message-scroller" className={`relative min-h-0 ${className}`} {...props}>
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
          railClassName={`${railOverflowing ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"} ${railClassName}`}
        >
          {viewport}
        </PreviewRail>
      ) : (
        viewport
      )}
      {showJumpToBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-12 z-20 flex justify-center">
          <button
            type="button"
            aria-label="Go to bottom"
            onClick={() => {
              setFollowing(true);
              scrollToEnd(reduce || !smooth ? "auto" : "smooth");
            }}
            className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full border border-line-strong/50 bg-surface/60 text-ink shadow-overlay backdrop-blur-chip transition-colors hover:bg-surface/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={20} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

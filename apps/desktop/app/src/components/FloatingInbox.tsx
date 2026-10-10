import { useEffect, useRef, useState, type SyntheticEvent, type PointerEvent, useEffectEvent } from "react";
import { AnimatePresence, motion, useReducedMotion, useIsPresent } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon, Cancel01Icon, InboxIcon, Settings01Icon, SentIcon } from "@hugeicons/core-free-icons";
import type { InboxItem, InboxStatus } from "@milagre/shared/attention";
import { visibleInbox } from "@milagre/shared/attention";
import { providerName } from "@milagre/shared/providers";
import { sessionIdFromKey } from "@milagre/shared/agent-runs";
import { resolvePalette } from "@milagre/shared/themes";
import type { QuestionAnswers, QuestionRequest } from "../model";
import type { FloatingDragOverlay } from "../electron";
import { bridgeForKey } from "../lib/computer-bridge";
import { useInbox } from "../lib/inbox";
import { useResolvedScheme, useSettings } from "../lib/settings";
import { applyPalette } from "../lib/theme-sheet";
import { useDismiss } from "../lib/use-dismiss";
import { answerSummary, draftAnswers, draftOf, pickOption, typeAnswer, type QuestionDrafts } from "../lib/question-answers";
import { ScrollArea } from "./primitives/ScrollArea";
import { RangeSlider } from "./primitives/RangeSlider";
import { ProviderLogo } from "./ProviderLogo";
import { PermissionCard } from "./agents/PermissionCard";

const statusWords: Record<InboxStatus, string> = {
  working: "Working",
  approval: "Needs approval",
  question: "Needs an answer",
  completed: "Finished",
  failed: "Failed",
};
const statusColor = (status: InboxStatus) =>
  status === "working"
    ? "bg-accent"
    : status === "question"
      ? "bg-accent-ink"
      : status === "completed"
        ? "bg-green"
        : status === "failed"
          ? "bg-red"
          : "bg-orange";
const needsYou = (item: InboxItem) => item.status === "approval" || item.status === "question";
const closeInbox = () => {
  void window.milagre.closeFloatingInbox();
};
const toggleInbox = () => {
  void window.milagre.toggleFloatingInbox();
};
const hidePreview = () => {
  void window.milagre.showInboxPreview(null);
};
const previewAgent = (item: InboxItem, event: SyntheticEvent<HTMLElement>, horizontal: boolean) => {
  const bounds = event.currentTarget.getBoundingClientRect();
  void window.milagre.showInboxPreview(item.key, horizontal ? bounds.x + bounds.width / 2 : bounds.y + bounds.height / 2);
};

export function FloatingInbox({ view }: { view: "dock" | "inbox" | "preview" | "drag" }) {
  return view === "drag" ? <FloatingDragTargets /> : <FloatingInboxContent view={view} />;
}

export function FloatingDragTargets() {
  const [state, setOverlay] = useState<FloatingDragOverlay | null>(null);
  useEffect(() => {
    let live = true,
      changed = false;
    const stop = window.milagre.onFloatingDragOverlay((next) => {
      changed = true;
      setOverlay(next);
    });
    void window.milagre.getFloatingDragOverlay().then((initial) => {
      if (live && !changed) setOverlay(initial);
    });
    return () => {
      live = false;
      stop();
    };
  }, []);
  return (
    <div data-floating-drag-overlay className="pointer-events-none fixed inset-0 bg-black/30">
      <p className="absolute top-12 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-5 py-2.5 text-[13px] text-white/90">
        Drop on a highlighted edge to dock. Release elsewhere to return.
      </p>
      {state?.targets.map((target) => (
        <div
          key={target.edge}
          data-snap-target={target.edge}
          data-active={target.active}
          className={`floating-snap-target floating-snap-${target.edge} ${target.active ? "is-active" : ""}`}
          style={{ left: target.x, top: target.y, width: target.width, height: target.height }}
        >
          <span className="floating-snap-mark" />
          <span className="floating-snap-label">{target.edge === "left" ? "Left" : target.edge === "right" ? "Right" : "Bottom"}</span>
        </div>
      ))}
    </div>
  );
}

function FloatingInboxContent({ view }: { view: "dock" | "inbox" | "preview" }) {
  const { snapshot: rawSnapshot, error, loading, refresh } = useInbox();
  const [selection, setSelection] = useState<{ key: string | null; revision: number }>({ key: null, revision: 0 });
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [placement, setPlacement] = useState<"left" | "right" | "bottom">("right");
  const [inboxOpen, setInboxOpen] = useState(false);
  const { colorTheme, customTheme, floatingInboxActivity } = useSettings();
  const snapshot = visibleInbox(rawSnapshot, floatingInboxActivity);
  const scheme = useResolvedScheme();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", scheme === "dark");
    applyPalette(resolvePalette(colorTheme, scheme, customTheme), scheme);
  }, [scheme, colorTheme, customTheme]);
  useEffect(() => {
    if (view === "dock") void window.milagre.resizeFloatingBar(snapshot.agents.length);
  }, [snapshot.agents.length, view]);
  useEffect(() => {
    if (view !== "dock") return;
    let live = true,
      changed = false;
    const stop = window.milagre.onFloatingPlacement((edge) => {
      changed = true;
      setPlacement(edge);
    });
    void window.milagre.getFloatingPlacement().then((edge) => {
      if (live && !changed) setPlacement(edge);
    });
    return () => {
      live = false;
      stop();
    };
  }, [view]);
  useEffect(() => {
    if (view !== "dock") return;
    let live = true,
      changed = false;
    const stop = window.milagre.onFloatingInboxOpen((open) => {
      changed = true;
      setInboxOpen(open);
    });
    void window.milagre.getFloatingInboxOpen().then((open) => {
      if (live && !changed) setInboxOpen(open);
    });
    return () => {
      live = false;
      stop();
    };
  }, [view]);
  useEffect(() => {
    if (view !== "preview") return;
    let live = true;
    let changed = false;
    const stop = window.milagre.onInboxPreview((key) => {
      changed = true;
      setPreviewKey(key);
    });
    void window.milagre.getInboxPreviewKey().then((key) => {
      if (live && !changed) setPreviewKey(key);
    });
    return () => {
      live = false;
      stop();
    };
  }, [view]);
  useEffect(() => {
    if (view !== "inbox") return;
    let live = true,
      changed = false;
    const stop = window.milagre.onSelectedInboxItem((key) => {
      changed = true;
      setSelection((previous) => ({ key, revision: previous.revision + 1 }));
    });
    void window.milagre.getSelectedInboxItem().then((key) => {
      if (live && !changed) setSelection((previous) => ({ key, revision: previous.revision + 1 }));
    });
    return () => {
      live = false;
      stop();
    };
  }, [view]);
  useDismiss(
    view === "inbox",
    closeInbox,
    (target) => !!target.closest("[data-inbox-panel]"),
    () => {},
  );
  if (view === "preview") return <InboxPreview item={snapshot.agents.find((item) => item.key === previewKey)} />;
  return view === "dock" ? (
    <FloatingBar agents={snapshot.agents} error={error} placement={placement} inboxOpen={inboxOpen} />
  ) : (
    <InboxPanel
      selectedChat={selection.key}
      selectionRevision={selection.revision}
      items={snapshot.items}
      working={snapshot.agents.filter((item) => item.status === "working").length}
      error={error}
      loading={loading}
      refresh={refresh}
    />
  );
}

export function FloatingBar({
  agents,
  error = "",
  placement = "right",
  inboxOpen = false,
}: {
  agents: InboxItem[];
  error?: string;
  placement?: "left" | "right" | "bottom";
  inboxOpen?: boolean;
}) {
  const reduce = useReducedMotion();
  const pointer = useRef<number | null>(null);
  const grip = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const expanded = hovered || dragging || inboxOpen;
  useEffect(() => {
    void window.milagre.expandFloatingBar(expanded, reduce === true);
  }, [expanded, reduce]);
  useEffect(() => () => clearTimeout(collapseTimer.current), []);
  const enter = () => {
    clearTimeout(collapseTimer.current);
    setHovered(true);
  };
  const leave = () => {
    hidePreview();
    clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => setHovered(false), 150);
  };
  useEffect(() => {
    if (!dragging) return;
    const release = (event: globalThis.PointerEvent) => {
      if (pointer.current !== event.pointerId) return;
      pointer.current = null;
      setDragging(false);
      void window.milagre.endFloatingDrag(event.type === "pointercancel");
    };
    const move = () => {
      if (pointer.current !== null) void window.milagre.moveFloatingDrag();
    };
    const capture = () => {
      if (pointer.current !== null) grip.current?.setPointerCapture(pointer.current);
    };
    // Resizing the native window can retarget the release to the logo or surface.
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("pointermove", move);
    window.addEventListener("resize", capture);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("resize", capture);
    };
  }, [dragging]);
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointer.current !== null) return;
    event.preventDefault();
    pointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    void window.milagre.beginFloatingDrag(window.matchMedia("(prefers-reduced-motion: reduce)").matches).then(() => {
      requestAnimationFrame(() => {
        if (pointer.current !== null) grip.current?.setPointerCapture(pointer.current);
      });
    });
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    void window.milagre.endFloatingDrag(cancel);
  };
  const horizontal = placement === "bottom" && !dragging;
  const divider = horizontal ? "mx-0.5 h-4 w-px bg-line" : "my-0.5 h-px w-4 bg-line";
  const pending = agents.filter(needsYou).length;
  const shown = agents.slice(0, 5);
  return (
    <aside
      data-floating-bar
      data-placement={placement}
      data-dragging={dragging}
      data-expanded={expanded}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) leave();
      }}
      aria-label="Milagre floating bar"
      className={`floating-inbox-tab floating-inbox-tab-${placement} flex items-center gap-1 bg-black text-white shadow-sm ${dragging ? "m-2 w-[38px] flex-col px-1 py-1.5" : horizontal ? `mx-6 ${expanded ? "mt-2 h-[46px]" : "mt-[26px] h-[28px]"} w-max flex-row px-1.5 pt-1 pb-3` : placement === "left" ? `my-6 mr-2 ${expanded ? "w-[46px]" : "w-[28px]"} flex-col py-1.5 pr-1 pl-3` : `my-6 ${expanded ? "ml-2 w-[46px]" : "ml-[26px] w-[28px]"} flex-col py-1.5 pr-3 pl-1`}`}
    >
      <div className="floating-inbox-reveal floating-inbox-leading" inert={!expanded} aria-hidden={!expanded}>
        <div
          ref={grip}
          data-floating-drag
          title="Drag to snap left, right, or bottom"
          onPointerDown={startDrag}
          onPointerUp={(event) => finishDrag(event)}
          onPointerCancel={(event) => finishDrag(event, true)}
          className={`floating-inbox-drag flex shrink-0 items-center justify-center ${horizontal ? "h-6 w-1.5" : "h-1.5 w-6"}`}
        >
          <span className={`rounded-full bg-ink-3/40 ${horizontal ? "h-3 w-0.5" : "h-0.5 w-3"}`} />
        </div>
        <button
          type="button"
          aria-label="Open Milagre inbox"
          title="Milagre inbox"
          onClick={toggleInbox}
          className="flex h-[26px] w-7 shrink-0 items-center justify-center rounded-[9px] text-white/70 hover:bg-white/10 hover:text-white"
        >
          <img src="./logo-milagre-image.png" alt="" className="size-[19px] rounded-[5px]" />
        </button>
        {!dragging && shown.length > 0 && <div className={divider} />}
      </div>
      {!dragging && (
        <>
          {shown.map((item) => (
            <button
              key={item.key}
              type="button"
              data-inbox-agent={item.key}
              aria-label={`${item.project}: ${item.title}. ${statusWords[item.status]}`}
              onMouseEnter={(event) => previewAgent(item, event, horizontal)}
              onMouseLeave={hidePreview}
              onFocus={(event) => previewAgent(item, event, horizontal)}
              onBlur={hidePreview}
              onClick={() => {
                hidePreview();
                void window.milagre.selectInboxItem(item.key);
              }}
              className="flex size-[27px] shrink-0 items-center justify-center rounded-[9px] hover:bg-hover"
            >
              {item.status === "working" ? (
                <span
                  data-inbox-loading
                  aria-label="Working"
                  className="size-[10px] animate-spin rounded-full border-[1.5px] border-accent/25 border-t-accent motion-reduce:animate-none"
                />
              ) : (
                <span className={`size-[7px] rounded-full ${statusColor(item.status)}`} />
              )}
            </button>
          ))}
          {agents.length > 5 && (
            <button
              type="button"
              onClick={toggleInbox}
              aria-label={`${agents.length - 5} more Chats. Open inbox`}
              className="flex h-[27px] w-7 shrink-0 items-center justify-center text-[9px] text-white/70 hover:text-white"
            >
              +{agents.length - 5}
            </button>
          )}
          {shown.length === 0 && !expanded && (
            <button type="button" aria-label="Open inbox" onClick={toggleInbox} className="flex size-[27px] items-center justify-center">
              <span className="size-[7px] rounded-full bg-white/40" />
            </button>
          )}
          <div className="floating-inbox-reveal floating-inbox-trailing" inert={!expanded} aria-hidden={!expanded}>
            <div className={divider} />
            <button
              type="button"
              data-inbox-trigger
              aria-label={`Open inbox${pending ? `, ${pending} Chats need you` : ""}`}
              title={error || "Open inbox"}
              onClick={toggleInbox}
              className="relative flex h-[30px] w-7 shrink-0 items-center justify-center rounded-[9px] bg-hover-2 text-ink"
            >
              <HugeiconsIcon icon={InboxIcon} size={16} strokeWidth={1.8} />
              {pending > 0 && (
                <span
                  data-inbox-badge
                  className="absolute -top-[3px] -right-0.5 flex min-w-[14px] items-center justify-center rounded-[5px] border-[1.5px] border-surface bg-orange px-0.5 text-[9px] leading-[11px] font-semibold text-page"
                >
                  {pending > 99 ? "99+" : pending}
                </span>
              )}
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

export function InboxPreview({ item }: { item?: InboxItem }) {
  if (!item) return null;
  return (
    <section role="tooltip" data-inbox-preview className="m-2 rounded-[14px] bg-surface p-3 text-ink shadow-sm">
      <div className="flex items-center gap-1.5 text-[10px] text-ink-3">
        <span className={`size-1.5 shrink-0 rounded-full ${statusColor(item.status)}`} />
        <span className="truncate">
          {item.project}
          {item.computer ? ` · ${item.computer}` : ""}
        </span>
        <span className="ml-auto shrink-0">{statusWords[item.status]}</span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-[12px] leading-4 font-medium">{item.title}</p>
      {item.preview && <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-ink-2">{item.preview}</p>}
    </section>
  );
}

export function InboxPanel({
  items,
  working,
  error = "",
  loading = false,
  refresh,
  selectedChat = null,
  selectionRevision = 0,
}: {
  selectedChat?: string | null;
  selectionRevision?: number;
  items: InboxItem[];
  working: number;
  error?: string;
  loading?: boolean;
  refresh: () => void;
}) {
  const reduce = useReducedMotion();
  const [selectedKey, setSelectedKey] = useState<string | null>(selectedChat);
  const [direction, setDirection] = useState(1);
  const [arrowPulse, setArrowPulse] = useState({ direction: 0, revision: 0 });
  const [savedDrafts, setSavedDrafts] = useState<Record<string, QuestionDrafts>>({});
  const header = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const receivedSelection = useRef<{ key: string; revision: number } | null>(null);
  const footer = useRef<HTMLElement>(null);
  useEffect(() => {
    const resize = () => {
      const height = 50 + [header.current, content.current, footer.current].reduce((sum, node) => sum + (node?.getBoundingClientRect().height ?? 0), 0);
      void window.milagre.resizeFloatingInbox(height, reduce === true);
    };
    const observer = new ResizeObserver(resize);
    for (const node of [header.current, content.current, footer.current]) if (node) observer.observe(node);
    resize();
    return () => observer.disconnect();
  }, [reduce]);
  const shown = items;
  const index = Math.max(
    0,
    shown.findIndex((item) => item.key === selectedKey),
  );
  const selected = shown[index];
  const draftKey = selected ? `${selected.key}:${selected.question?.requestId ?? ""}` : "";
  const select = (next: number) => {
    if (!shown[next] || next === index) return;
    scroller.current?.scrollTo({ top: 0 });
    setDirection(next > index ? 1 : -1);
    setArrowPulse((previous) => ({ direction: next > index ? 1 : -1, revision: previous.revision + 1 }));
    setSelectedKey(shown[next].key);
  };
  const receiveSelection = useEffectEvent(() => {
    if (!selectedChat) return;
    if (receivedSelection.current?.key === selectedChat && receivedSelection.current.revision === selectionRevision) return;
    const next = items.findIndex((item) => item.key === selectedChat);
    if (next >= 0) {
      receivedSelection.current = { key: selectedChat, revision: selectionRevision };
      scroller.current?.scrollTo({ top: 0 });
      setDirection(next > index ? 1 : -1);
      setSelectedKey(selectedChat);
    }
  });
  useEffect(() => {
    receiveSelection();
  }, [selectedChat, selectionRevision, items]);
  const navigate = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      closeInbox();
      return;
    }
    if (event.key.toLowerCase() === "d" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.isComposing && !event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      closeInbox();
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (event.altKey || event.ctrlKey || event.metaKey || target?.closest("input, textarea, [contenteditable=true]")) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (target?.closest('[role="slider"]')) return;
      event.preventDefault();
      select(index + (event.key === "ArrowRight" ? 1 : -1));
    }
  });
  useEffect(() => {
    const handle = (event: KeyboardEvent) => navigate(event);
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, []);
  const shortcutOptions = selected?.question?.questions.length === 1 ? selected.question.questions[0].options.slice(0, 9) : [];
  return (
    <div data-inbox-panel aria-label="Inbox" className="floating-inbox-panel m-3 flex h-[calc(100vh-24px)] flex-col gap-2 text-ink">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-line-strong bg-surface shadow-sm">
        <header ref={header} className="flex items-center justify-end gap-2 px-4 pt-2">
          {shown.length > 0 && (
            <nav data-inbox-pagination aria-label="Inbox pages" className="flex items-center">
              <button
                type="button"
                aria-label="Previous message"
                aria-keyshortcuts="ArrowLeft"
                title="Previous message (Left arrow)"
                data-inbox-arrow="left"
                disabled={index === 0}
                onClick={() => select(index - 1)}
                className="flex size-6 items-center justify-center rounded-full text-ink-3 hover:bg-hover disabled:opacity-25"
              >
                <motion.span
                  key={arrowPulse.direction === -1 ? arrowPulse.revision : 0}
                  initial={{ opacity: 0.45, x: 0, scale: 1 }}
                  animate={
                    arrowPulse.direction === -1
                      ? { opacity: [0.45, 1, 0.45], x: reduce ? 0 : [0, -4, 0], scale: reduce ? 1 : [1, 1.3, 1] }
                      : { opacity: 0.45, x: 0, scale: 1 }
                  }
                  transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}
                  className="flex text-black dark:text-white"
                >
                  <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
                </motion.span>
              </button>
              <RangeSlider
                variant="position"
                showTicks={false}
                label="Inbox position"
                min={0}
                max={shown.length - 1}
                value={index}
                disabled={shown.length < 2}
                formatValueText={(page) => `Chat ${page + 1} of ${shown.length}`}
                onValueChange={select}
                className="mx-2 w-[100px] shrink-0"
              />
              <span data-inbox-count aria-live="polite" className="min-w-[49px] text-center text-[11px] text-ink-3 tabular-nums">
                {index + 1} of {shown.length}
              </span>
              <button
                type="button"
                aria-label="Next message"
                aria-keyshortcuts="ArrowRight"
                title="Next message (Right arrow)"
                data-inbox-arrow="right"
                disabled={index === shown.length - 1}
                onClick={() => select(index + 1)}
                className="flex size-6 items-center justify-center rounded-full text-ink-3 hover:bg-hover disabled:opacity-25"
              >
                <motion.span
                  key={arrowPulse.direction === 1 ? arrowPulse.revision : 0}
                  initial={{ opacity: 0.45, x: 0, scale: 1 }}
                  animate={
                    arrowPulse.direction === 1
                      ? { opacity: [0.45, 1, 0.45], x: reduce ? 0 : [0, 4, 0], scale: reduce ? 1 : [1, 1.3, 1] }
                      : { opacity: 0.45, x: 0, scale: 1 }
                  }
                  transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}
                  className="flex text-black dark:text-white"
                >
                  <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
                </motion.span>
              </button>
            </nav>
          )}
          <button
            type="button"
            aria-label="Close inbox"
            title="Close inbox (Esc or Cmd/Ctrl+D)"
            onClick={closeInbox}
            className="flex size-7 items-center justify-center rounded-full text-ink-3 hover:bg-hover hover:text-ink"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={15} />
          </button>
        </header>
        <ScrollArea ref={scroller} data-inbox-scroller className="flex-1 px-4 pt-1 pb-3">
          <div ref={content} className="relative">
            {error ? (
              <div role="alert" className="rounded-control bg-red-tint p-3 text-xs text-red">
                {error}
                <button type="button" className="mt-2 block underline" onClick={refresh}>
                  Retry
                </button>
              </div>
            ) : loading ? (
              <p role="status" className="py-10 text-center text-xs text-ink-3">
                Loading inbox…
              </p>
            ) : shown.length === 0 ? (
              <div data-inbox-empty className="px-3 py-12 text-center">
                <p className="text-[15px] font-medium">All caught up</p>
                <p className="mt-2 text-xs leading-5 text-ink-3">Questions and finished work will appear here.</p>
              </div>
            ) : (
              <AnimatePresence initial={false} mode="popLayout" custom={direction}>
                <motion.div
                  key={`${selected.key}:${selected.permission?.requestId ?? selected.question?.requestId ?? selected.at}`}
                  custom={direction}
                  variants={{
                    enter: (way: number) => ({ opacity: 0, x: way * 48 }),
                    center: { opacity: 1, x: 0 },
                    exit: (way: number) => ({ opacity: 0, x: way * -48 }),
                  }}
                  initial={reduce ? false : "enter"}
                  animate="center"
                  exit={reduce ? undefined : "exit"}
                  transition={{ duration: reduce ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
                >
                  <InboxCard
                    item={selected}
                    refresh={refresh}
                    drafts={savedDrafts[draftKey] ?? {}}
                    setDrafts={(drafts) => setSavedDrafts((saved) => ({ ...saved, [draftKey]: drafts }))}
                  />
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        </ScrollArea>
      </section>
      <footer ref={footer} className="flex shrink-0 items-center justify-center gap-2">
        {(selected || shortcutOptions.length > 0 || shown.length > 1) && (
          <p data-inbox-shortcuts className="rounded-full border border-line-strong bg-surface px-3 py-1.5 text-[11px] text-ink-2">
            {selected && !selected.question && (
              <>
                Press <kbd className="rounded bg-hover-2 px-1 py-0.5 font-sans">Enter</kbd> {selected.permission ? "to allow once" : "to open Chat"}
              </>
            )}
            {shortcutOptions.length > 0 && (
              <>
                Press{" "}
                {shortcutOptions.map((option, optionIndex) => (
                  <span key={option.label}>
                    {optionIndex ? " / " : ""}
                    <kbd className="rounded bg-hover-2 px-1 py-0.5 font-sans">{optionIndex + 1}</kbd>
                  </span>
                ))}{" "}
                {selected?.question?.questions[0].multiSelect ? "to select · Enter to send" : "to answer"}
              </>
            )}
            {shown.length > 1 && (
              <span data-inbox-navigation-hint>
                {(selected && !selected.question) || shortcutOptions.length > 0 ? " · " : ""}
                <kbd className="rounded bg-hover-2 px-1 py-0.5 font-sans">←</kbd> <kbd className="rounded bg-hover-2 px-1 py-0.5 font-sans">→</kbd> to move
              </span>
            )}
          </p>
        )}
        <button
          type="button"
          aria-label="Floating inbox settings"
          title={`${working} ${working === 1 ? "agent" : "agents"} working · Settings`}
          onClick={() => {
            void window.milagre.openInboxSettings();
          }}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface text-ink-3 hover:text-ink-2"
        >
          <HugeiconsIcon icon={Settings01Icon} size={12} />
        </button>
      </footer>
    </div>
  );
}

function InboxCard({
  item,
  refresh,
  drafts,
  setDrafts,
}: {
  item: InboxItem;
  refresh: () => void;
  drafts: QuestionDrafts;
  setDrafts: (drafts: QuestionDrafts) => void;
}) {
  const present = useIsPresent();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const action = async (run: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if ((await run()) === false) throw new Error("This request is no longer waiting. Refresh the inbox.");
      setDrafts({});
      refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not send your answer.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const open = () => {
    void window.milagre.openInboxChat(item.key).catch((failure) => setError(failure.message));
  };
  const primaryOnEnter = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : document.activeElement;
    if (
      !present ||
      item.question ||
      pending.current ||
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.repeat ||
      event.isComposing ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=link]") ||
      (target?.closest("button, [role=button]") && !target.closest("[data-inbox-pagination]"))
    )
      return;
    event.preventDefault();
    if (item.permission) void action(() => bridgeForKey(item.key).respondToPermission(item.key, item.permission!.requestId, "allow"));
    else open();
  });
  useEffect(() => {
    const handle = (event: KeyboardEvent) => primaryOnEnter(event);
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  return (
    <article inert={!present} aria-hidden={!present} data-inbox-item={item.key} className="py-0.5" aria-busy={busy}>
      <button type="button" onClick={open} title={`Open ${item.title}`} className="flex max-w-full items-center gap-3 text-left">
        <span className="relative flex size-7 shrink-0 items-center justify-center">
          <ProviderLogo provider={item.provider ?? "claude"} size={24} />
          <span
            aria-label={statusWords[item.status]}
            className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface ${statusColor(item.status)}`}
          />
        </span>
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold">{providerName(item.provider ?? "claude")}</span>
          <span className="block truncate text-[12px] text-ink-3">
            {item.status === "question" ? "Waiting for your answer" : item.status === "approval" ? "Waiting for approval" : statusWords[item.status]} ·{" "}
            {item.project}
            {item.computer ? ` · ${item.computer}` : ""}
          </span>
        </span>
      </button>
      {item.question ? (
        <InboxQuestion
          request={item.question}
          provider={providerName(item.provider ?? "claude")}
          busy={busy}
          drafts={drafts}
          setDrafts={setDrafts}
          send={(answers) =>
            void action(() =>
              bridgeForKey(item.key).answerQuestion(
                item.key,
                item.question!.requestId,
                answers,
                answers ? answerSummary(item.question!.questions, answers) : undefined,
              ),
            )
          }
        />
      ) : item.permission ? (
        <div className="mt-3">
          <PermissionCard
            variant="inline"
            request={item.permission}
            waiting={0}
            answering={busy ? "allow" : null}
            onAnswer={(decision) => void action(() => bridgeForKey(item.key).respondToPermission(item.key, item.permission!.requestId, decision))}
          />
        </div>
      ) : (
        <>
          <h2 className={`mt-3 text-[15px] font-medium ${item.status === "failed" ? "text-red" : ""}`}>
            {item.status === "failed" ? "Turn failed" : item.status === "working" ? item.title : "Ready to review"}
          </h2>
          <p className="mt-2 text-xs leading-5 text-ink-2">{item.preview}</p>
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red">
          {error}
        </p>
      )}
      {!needsYou(item) && item.status !== "working" && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={open}
            aria-keyshortcuts="Enter"
            title="Open Chat (Enter)"
            className="rounded-control bg-ink px-3 py-2 text-xs font-medium text-surface"
          >
            Open Chat
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void action(() => bridgeForKey(item.key).patchChat(item.projectPath, sessionIdFromKey(item.key), { unread: false }))}
            className="rounded-control px-2 py-2 text-xs text-ink-2 disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      )}
    </article>
  );
}

function InboxQuestion({
  request,
  busy,
  send,
  drafts,
  setDrafts,
  provider,
}: {
  request: QuestionRequest;
  provider: string;
  busy: boolean;
  send: (answers: QuestionAnswers | null) => void;
  drafts: QuestionDrafts;
  setDrafts: (drafts: QuestionDrafts) => void;
}) {
  const present = useIsPresent();
  const answers = draftAnswers(request.questions, drafts);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        !present ||
        busy ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        target?.closest("input, textarea, [contenteditable=true]")
      )
        return;
      if (
        event.key === "Enter" &&
        answers &&
        (!target?.closest("button") ||
          target.closest("[data-inbox-question] [role=radio], [data-inbox-question] [role=checkbox], [data-inbox-question] [type=submit]"))
      ) {
        event.preventDefault();
        send(answers);
      } else if (request.questions.length === 1 && /^[1-9]$/.test(event.key)) {
        const question = request.questions[0],
          option = question.options[Number(event.key) - 1];
        if (option) {
          event.preventDefault();
          setDrafts(pickOption(drafts, question, option.label));
          if (!question.multiSelect) send({ [question.id]: [option.label] });
        }
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [answers, busy, drafts, request, send, setDrafts, present]);
  const label = request.questions.length > 1 ? "Send answers" : "Send answer";
  const sendButton = (
    <button
      type="submit"
      aria-label={label}
      title={busy ? "Sending…" : label}
      disabled={busy || !answers}
      className="flex size-8 shrink-0 items-center justify-center rounded-[9px] text-ink-2 hover:bg-hover-2 disabled:opacity-30"
    >
      <HugeiconsIcon icon={SentIcon} size={18} strokeWidth={1.5} />
    </button>
  );
  return (
    <form
      data-inbox-question
      className="mt-4 grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && answers) send(answers);
      }}
    >
      {request.questions.map((question, questionIndex) => {
        const draft = draftOf(drafts, question.id);
        const last = questionIndex === request.questions.length - 1;
        return (
          <fieldset key={question.id} className="min-w-0">
            <legend className="mb-3 text-[14px] leading-5 font-semibold">{question.question}</legend>
            <div className="grid gap-1.5">
              {question.options.map((option, optionIndex) => {
                const recommended = /\s*\(Recommended\)\s*$/i.test(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    role={question.multiSelect ? "checkbox" : "radio"}
                    aria-label={option.label}
                    aria-checked={draft.picked.includes(option.label)}
                    disabled={busy}
                    title={option.description}
                    onClick={(event) => {
                      event.currentTarget.focus();
                      setDrafts(pickOption(drafts, question, option.label));
                    }}
                    className={`flex min-h-8 w-full items-center gap-2 rounded-[11px] border px-2.5 py-2 text-left text-[12px] disabled:opacity-50 ${draft.picked.includes(option.label) ? "border-accent-ink bg-accent-tint text-ink" : "border-line bg-field text-ink-2 hover:bg-hover-2"}`}
                  >
                    <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-hover-2 text-[11px] text-ink-2">
                      {optionIndex + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      {option.label.replace(/\s*\(Recommended\)\s*$/i, "")}
                      {option.description && <span className="mt-0.5 block text-[10px] leading-4 text-ink-3">{option.description}</span>}
                    </span>
                    {recommended && <span className="shrink-0 rounded-full bg-orange/15 px-1.5 py-0.5 text-[10px] font-medium text-orange">Recommended</span>}
                  </button>
                );
              })}
            </div>
            {question.allowOther && (
              <div className="mt-2 flex min-h-9 items-center gap-1 rounded-[11px] border border-line bg-field px-2">
                <input
                  type={question.secret ? "password" : "text"}
                  aria-label={`Your own answer to: ${question.question}`}
                  placeholder={`Reply to ${provider}…`}
                  autoComplete="off"
                  disabled={busy}
                  value={draft.typed}
                  onChange={(event) => setDrafts(typeAnswer(drafts, question, event.target.value))}
                  className="min-w-0 flex-1 bg-transparent px-0.5 py-2 text-[12px] text-ink outline-none placeholder:text-ink-3"
                />
                {last && sendButton}
              </div>
            )}
            {!question.allowOther && last && (
              <div className="mt-2 flex min-h-9 items-center justify-between rounded-[11px] border border-line bg-field px-2">
                <span className="px-0.5 text-[12px] text-ink-3">{answers ? "Send your selection" : "Choose an answer"}</span>
                {sendButton}
              </div>
            )}
          </fieldset>
        );
      })}
      <button type="button" disabled={busy} onClick={() => send(null)} className="justify-self-end text-[10px] text-ink-3 hover:text-ink-2 disabled:opacity-40">
        Dismiss
      </button>
    </form>
  );
}

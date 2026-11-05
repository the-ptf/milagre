import { useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft01Icon, MoreHorizontalIcon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { chatBookmark } from "@milagre/shared/subchats";
import { chatTitle } from "@milagre/shared/chats";
import { familyEntry, familyMenuModel, type FamilyEntry } from "../../lib/family-menu";
import { setBookmarkReserve } from "../../lib/bookmark-reserve";
import { useDisplayNow } from "../../lib/display-clock";
import { useShortcutLabel } from "../../lib/keybindings";
import { useRoutines } from "../../lib/routines";
import type { SubchatSource } from "../../lib/subchat-track";
import { useControlsClearance } from "../../lib/window-chrome";
import { Icon } from "../primitives/Icon";
import Tooltip from "../primitives/Tooltip";
import { ChatMarkDot } from "../sidebar/ChatRow";
import { FamilyMenu } from "./FamilyMenu";

// Both ends are capped and truncate at the tail, the parent first, so the open Chat's title is the last thing to go.
const CRUMB = "no-drag flex h-7 min-w-0 items-center rounded-control text-13 font-medium transition-colors active:scale-press focus-visible:outline-2";

type Reads = Omit<SubchatSource, "parentKey">;

/**
 * Where the open Subchat lives, in the 44px strip at the left of <main>: `‹ ● Parent title / Subchat title ⇅`. The left
 * button goes up one level (App's openAlone on the parent) and the right one opens the family menu. It is read from the
 * Chat's own `parent`, never from how it was opened, so it survives a reload. A Chat that delegated further up shows only
 * its nearest listed ancestor, the older ones collapsing into a "…" that opens the same menu.
 *
 * Its right edge goes into `chipStripInsets` (bookmark-reserve.ts), so the Routine chip and the window's corner buttons
 * keep clear of it. `corner` is the width of those buttons.
 */
export function SubchatBookmark({
  chatKey,
  reads,
  corner,
  onOpen,
  onBeside,
  onShowAll,
}: {
  chatKey: string;
  reads: Reads;
  corner: number;
  onOpen: (key: string) => void;
  onBeside: (parent: string) => void;
  onShowAll: () => void;
}) {
  const bookmark = chatBookmark(reads.sessions, chatKey);
  const [menuOpen, setMenuOpen] = useState(false);
  const { routines } = useRoutines();
  const now = useDisplayNow(1000, menuOpen);
  const { bar, inset } = useControlsClearance<HTMLDivElement>(bookmark !== null, corner);
  const group = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const full = { ...reads, routines, now };
  const hasParent = bookmark !== null;
  const parent = bookmark ? familyEntry(bookmark.parent, full, false) : null;
  const model = menuOpen ? familyMenuModel(chatKey, full) : null;
  const shortcut = useShortcutLabel("chat.parent");
  const session = reads.sessions?.[Number(chatKey.slice(chatKey.lastIndexOf("#") + 1))];
  // Tell <main>'s other top-strip occupant (the Routine chip) where this one ends; nothing when it unmounts.
  useLayoutEffect(() => {
    const host = bar.current?.offsetParent;
    const box = group.current;
    if (!hasParent || !(host instanceof HTMLElement) || !box) return;
    const update = () => setBookmarkReserve(box.getBoundingClientRect().right - host.getBoundingClientRect().left + 8);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    observer.observe(host);
    return () => {
      observer.disconnect();
      setBookmarkReserve(0);
    };
  }, [hasParent, bar]);
  if (!bookmark || !parent || !session) return null;
  const title = chatTitle(session);
  const needsYou = parent.mark === "question" || parent.mark === "waiting";
  return (
    <div
      ref={bar}
      data-subchat-bookmark
      style={inset}
      className="pointer-events-none absolute inset-x-3 top-[var(--window-chrome-top)] z-[55] flex h-8 items-center"
    >
      <div ref={group} className="pointer-events-auto flex min-w-0 max-w-full items-center gap-1">
        {bookmark.above.length > 0 && (
          <>
            <button
              type="button"
              aria-label="Show the Chats above this one"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
              className={`${CRUMB} w-7 shrink-0 justify-center text-ink-3 hover:bg-hover hover:text-ink`}
            >
              <Icon icon={MoreHorizontalIcon} size={14} />
            </button>
            <Divider />
          </>
        )}
        <ParentButton entry={parent} needsYou={needsYou} shortcut={shortcut} onOpen={() => onOpen(parent.key)} />
        <Divider />
        <Tooltip label={title} side="bottom" align="start" asChild>
          <button
            ref={trigger}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${title}, show the Chats in this family`}
            data-bookmark-current
            onClick={() => setMenuOpen((open) => !open)}
            className={`${CRUMB} max-w-[240px] shrink gap-1 px-2 text-ink hover:bg-hover`}
          >
            <span className="min-w-0 truncate">{title}</span>
            <Icon icon={UnfoldMoreIcon} size={14} className="shrink-0 text-ink-3" />
          </button>
        </Tooltip>
      </div>
      {model && (
        <FamilyMenu
          model={model}
          openKey={chatKey}
          anchor={trigger}
          onPick={onOpen}
          onBeside={() => onBeside(parent.key)}
          onShowAll={onShowAll}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}

const Divider = () => (
  <span aria-hidden className="shrink-0 px-0.5 text-13 text-ink-4">
    /
  </span>
);

/** The way up: the parent's live dot and title, tinted with "Needs you" when the parent waits on an answer. */
function ParentButton({ entry, needsYou, shortcut, onOpen }: { entry: FamilyEntry; needsYou: boolean; shortcut: string | undefined; onOpen: () => void }) {
  return (
    <Tooltip label={entry.title} shortcut={shortcut} side="bottom" align="start" asChild>
      <button
        type="button"
        data-bookmark-parent={entry.key}
        data-needs-you={needsYou || undefined}
        aria-label={needsYou ? `Back to ${entry.title}, needs you` : `Back to ${entry.title}`}
        onClick={onOpen}
        className={`${CRUMB} shrink-[4] pr-2.5 pl-1.5 ${needsYou ? "max-w-[260px] bg-orange-tint text-ink" : "max-w-[180px] bg-field text-ink-2 hover:bg-hover-2"}`}
      >
        <Icon icon={ArrowLeft01Icon} size={14} className="mr-1 shrink-0" />
        <ChatMarkDot mark={entry.mark} background={entry.background} />
        <span className="min-w-0 truncate">{entry.title}</span>
        {/* Never truncated: it is the reason the button is tinted. */}
        {needsYou && <span className="ml-1.5 shrink-0 text-12 font-medium text-orange-ink">Needs you</span>}
      </button>
    </Tooltip>
  );
}

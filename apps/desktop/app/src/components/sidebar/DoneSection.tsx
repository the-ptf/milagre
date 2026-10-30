import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon, CheckmarkCircle02Icon, HourglassIcon, Undo02Icon } from "@hugeicons/core-free-icons";
import { doneCountdown } from "@milagre/shared/done";
import { preferenceStorage as localStorage } from "../../lib/preference-storage.ts";
import { useDisplayNow } from "../../lib/display-clock";
import { ScrollArea } from "../primitives/ScrollArea";
import { ChatTitle } from "./ChatTitle";
import { computerIcon, type RowComputer, type SidebarRecent } from "./ChatRow";

/**
 * A Done chat with what its own scope does with it: open it, or take it back to the list. `computer`: the one it lives on,
 * once there are two or more.
 */
export type DoneEntry = {
  key: string;
  item: SidebarRecent;
  onPick: (item: SidebarRecent) => void;
  onReopen?: (id: string) => void;
  computer?: RowComputer;
};

const OPEN_KEY = "milagre.sidebarDoneOpen";

/*
 * DONE
 * The sidebar's last section, under the chats and pinned to the bottom: chats marked Done, most recent first, folded
 * by default. Each shows its computer (with two or more), the time left before the host archives it, and Reopen on hover.
 * Clicking one opens it.
 */
export function DoneSection({ entries, retentionHours, collapsed }: { entries: DoneEntry[]; retentionHours: number; collapsed: boolean }) {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
  const now = useDisplayNow(30_000, open && entries.length > 0);
  if (collapsed || entries.length === 0) return null;
  const toggle = () => {
    setOpen(!open);
    localStorage.setItem(OPEN_KEY, open ? "0" : "1");
  };
  return (
    <section data-done-section aria-label="Done" className="mx-2 mt-2 shrink-0 border-t border-line pt-1.5">
      <button
        type="button"
        data-done-toggle
        aria-expanded={open}
        onClick={toggle}
        className="sidebar-copy flex h-7 w-full items-center gap-1.5 rounded-control px-2 text-left text-ink-3 hover:bg-hover-2 hover:text-ink-2"
      >
        <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={14} strokeWidth={2} color="currentColor" />
        <span className="text-[length:calc(12.5px+var(--sidebar-delta))] font-medium text-ink-2">Done</span>
        <span data-done-count className="text-[length:calc(12px+var(--sidebar-delta))] tabular-nums">
          {entries.length}
        </span>
      </button>
      {open && (
        <ScrollArea className="max-h-[186px]">
          <ul className="flex flex-col gap-px pb-0.5">
            {entries.map((entry) => (
              <DoneRow key={`${entry.key}#${entry.item.id}`} entry={entry} countdown={doneCountdown({ done_at: entry.item.doneAt }, retentionHours, now)} />
            ))}
          </ul>
        </ScrollArea>
      )}
    </section>
  );
}

function DoneRow({ entry, countdown }: { entry: DoneEntry; countdown: string | null }) {
  const { item, onPick, onReopen, computer } = entry;
  return (
    <li data-done-row={item.id} className="group/done relative">
      <button
        type="button"
        onClick={() => onPick(item)}
        className={`sidebar-copy flex w-full items-center gap-2.5 rounded-control px-2 text-left hover:bg-hover-2 ${computer ? "h-[42px]" : "h-[30px]"}`}
      >
        <span className="flex shrink-0 text-ink-4">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} strokeWidth={2} color="currentColor" />
        </span>
        {/* With two or more computers, the one the chat lives on goes under its title, so both stay readable. */}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[length:calc(13px+var(--sidebar-delta))] text-ink-3 group-hover/done:text-ink-2">
            <ChatTitle label={item.label} />
          </span>
          {computer && (
            <span
              data-done-computer
              className={`flex min-w-0 items-center gap-1 text-[length:calc(11px+var(--sidebar-delta))] ${computer.offline ? "text-orange-ink" : "text-ink-4"}`}
            >
              <HugeiconsIcon icon={computerIcon(computer)} size={11} strokeWidth={2} color="currentColor" className="shrink-0" />
              <span className="truncate">{computer.offline ? `${computer.name}, offline` : computer.name}</span>
            </span>
          )}
        </span>
        {countdown && (
          <span
            data-done-countdown
            title="Time left before it is archived"
            className={`flex shrink-0 items-center gap-1 text-[length:calc(11px+var(--sidebar-delta))] font-medium tabular-nums text-ink-3 ${onReopen ? "group-focus-within/done:opacity-0 group-hover/done:opacity-0" : ""}`}
          >
            <HugeiconsIcon icon={HourglassIcon} size={11} strokeWidth={2} color="currentColor" />
            {countdown}
          </span>
        )}
      </button>
      {onReopen && (
        <button
          type="button"
          data-done-reopen
          aria-label={`Reopen ${item.label}`}
          onClick={() => onReopen(item.id)}
          className="absolute right-2 top-1/2 flex h-5 -translate-y-1/2 items-center gap-1 rounded-inline px-1 text-[length:calc(11.5px+var(--sidebar-delta))] font-medium text-ink-2 opacity-0 transition-opacity duration-100 hover:text-ink focus-visible:opacity-100 group-hover/done:opacity-100"
        >
          <HugeiconsIcon icon={Undo02Icon} size={12} strokeWidth={2} color="currentColor" />
          Reopen
        </button>
      )}
    </li>
  );
}

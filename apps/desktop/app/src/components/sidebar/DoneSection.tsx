import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon, HourglassIcon, Undo02Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { doneCountdown } from "@milagre/shared/done";
import { preferenceStorage as localStorage } from "../../lib/preference-storage.ts";
import { useDisplayNow } from "../../lib/display-clock";
import { ScrollArea } from "../primitives/ScrollArea";
import Tooltip from "../primitives/Tooltip";
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
 * by default. Each shows the time left before the host archives it at the right of its title, its computer under it (with
 * two or more), and a Reopen icon on hover.
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
    <section data-done-section aria-label="Done" className="mx-2 mt-2 shrink-0 pt-1.5">
      <AsideToggle kind="done" label="Done" count={entries.length} open={open} onToggle={toggle} />
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

/** A foot section's header (Done, Snoozed): its name and count, folding the list under it. */
export function AsideToggle({ kind, label, count, open, onToggle }: { kind: string; label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      {...{ [`data-${kind}-toggle`]: "" }}
      aria-expanded={open}
      onClick={onToggle}
      className="sidebar-copy flex h-7 w-full items-center gap-1.5 rounded-control px-2 text-left text-ink-3 hover:bg-hover-2 hover:text-ink-2"
    >
      <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={14} strokeWidth={2} color="currentColor" />
      <span className="text-[length:calc(12.5px+var(--sidebar-delta))] font-medium text-ink-2">{label}</span>
      <span {...{ [`data-${kind}-count`]: "" }} className="text-[length:calc(12px+var(--sidebar-delta))] tabular-nums">
        {count}
      </span>
    </button>
  );
}

function DoneRow({ entry, countdown }: { entry: DoneEntry; countdown: string | null }) {
  const { item, onPick, onReopen, computer } = entry;
  return (
    <AsideRow
      kind="done"
      item={item}
      computer={computer}
      onPick={onPick}
      time={countdown ? { text: countdown, icon: HourglassIcon, title: "Time left before it is archived" } : null}
      action={onReopen && { label: "Reopen", icon: Undo02Icon, run: () => onReopen(item.id) }}
    />
  );
}

/**
 * One row of a section at the sidebar's foot (Done, Snoozed): the title with its time at the right of the same line, the
 * computer under it with two or more, and the row's one action as an icon in the time's place on hover. Clicking it
 * opens the Chat. `kind` names its data attributes: `data-done-row`, `data-done-countdown`, `data-done-reopen`, and
 * `data-snoozed-row`, `data-snoozed-wake`, `data-snoozed-label`.
 */
export function AsideRow({
  kind,
  item,
  computer,
  onPick,
  time,
  action,
}: {
  kind: "done" | "snoozed";
  item: SidebarRecent;
  computer?: RowComputer;
  onPick: (item: SidebarRecent) => void;
  time?: { text: string; icon: IconSvgElement; title: string } | null | false;
  action?: { label: string; icon: IconSvgElement; run: () => void } | null | false;
}) {
  const attr = (name: string) => ({ [`data-${kind}-${name}`]: name === "row" ? item.id : "" });
  return (
    <li {...attr("row")} className="group/aside relative">
      <button
        type="button"
        onClick={() => onPick(item)}
        className={`sidebar-copy flex w-full flex-col justify-center rounded-control px-2 text-left hover:bg-hover-2 ${computer ? "h-[42px]" : "h-[30px]"}`}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[length:calc(13px+var(--sidebar-delta))] text-ink-3 group-hover/aside:text-ink-2">
            <ChatTitle label={item.label} />
          </span>
          {time && (
            <span
              {...(kind === "done" ? { "data-done-countdown": "" } : { "data-snoozed-label": "" })}
              title={time.title}
              className={`flex shrink-0 items-center gap-1 text-[length:calc(11px+var(--sidebar-delta))] font-medium tabular-nums text-ink-3 ${action ? "group-focus-within/aside:opacity-0 group-hover/aside:opacity-0" : ""}`}
            >
              <HugeiconsIcon icon={time.icon} size={11} strokeWidth={2} color="currentColor" />
              {time.text}
            </span>
          )}
        </span>
        {/* With two or more computers, the one the chat lives on goes under its title, so both stay readable. */}
        {computer && (
          <span
            {...attr("computer")}
            className={`flex min-w-0 items-center gap-1 text-[length:calc(11px+var(--sidebar-delta))] ${computer.offline ? "text-orange-ink" : "text-ink-4"}`}
          >
            <HugeiconsIcon icon={computerIcon(computer)} size={11} strokeWidth={2} color="currentColor" className="shrink-0" />
            <span className="truncate">{computer.offline ? `${computer.name}, offline` : computer.name}</span>
          </span>
        )}
      </button>
      {action && (
        <Tooltip label={action.label} align="end" asChild>
          <button
            type="button"
            {...(kind === "done" ? { "data-done-reopen": "" } : { "data-snoozed-wake": "" })}
            aria-label={`${action.label} ${item.label}`}
            onClick={action.run}
            className={`absolute right-1.5 flex size-5 items-center justify-center rounded-inline text-ink-2 opacity-0 transition-opacity duration-100 hover:text-ink focus-visible:opacity-100 group-hover/aside:opacity-100 ${computer ? "top-[4px]" : "top-1/2 -translate-y-1/2"}`}
          >
            <HugeiconsIcon icon={action.icon} size={14} strokeWidth={2} color="currentColor" />
          </button>
        </Tooltip>
      )}
    </li>
  );
}

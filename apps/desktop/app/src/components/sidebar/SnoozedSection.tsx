import { useState } from "react";
import { AlarmClockIcon, AlarmClockOffIcon } from "@hugeicons/core-free-icons";
import { snoozeTimeLabel, snoozeWakeLabel } from "@milagre/shared/snooze";
import { preferenceStorage as localStorage } from "../../lib/preference-storage.ts";
import { useDisplayNow } from "../../lib/display-clock";
import { ScrollArea } from "../primitives/ScrollArea";
import { AsideRow, AsideToggle } from "./DoneSection";
import type { RowComputer, SidebarRecent } from "./ChatRow";

/** A snoozed chat with what its own scope does with it: open it, or wake it now. `computer`: with two or more. */
export type SnoozedEntry = {
  key: string;
  item: SidebarRecent;
  onPick: (item: SidebarRecent) => void;
  onWake?: (id: string) => void;
  computer?: RowComputer;
};

// Kept as "0" once folded: the section starts open, so a Chat just snoozed is seen landing there.
const OPEN_KEY = "milagre.sidebarSnoozedOpen";

/*
 * SNOOZED
 * Above Done at the sidebar's foot: snoozed chats (snooze.mjs), the one waking soonest first. Each shows how long until
 * it wakes at the right of its title (the wake time on hover of it), its computer under it with two or more, and a Wake
 * icon on hover. The host takes a chat out when its time comes, or at once on a question, an approval or a failed turn.
 */
export function SnoozedSection({ entries, collapsed }: { entries: SnoozedEntry[]; collapsed: boolean }) {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) !== "0");
  const now = useDisplayNow(30_000, open && entries.length > 0);
  if (collapsed || entries.length === 0) return null;
  const toggle = () => {
    setOpen(!open);
    localStorage.setItem(OPEN_KEY, open ? "0" : "1");
  };
  return (
    <section data-snoozed-section aria-label="Snoozed" className="mx-2 mt-2 shrink-0 pt-1.5">
      <AsideToggle kind="snoozed" label="Snoozed" count={entries.length} open={open} onToggle={toggle} />
      {open && (
        <ScrollArea className="max-h-[186px]">
          <ul className="flex flex-col gap-px pb-0.5">
            {entries.map(({ key, item, onPick, onWake, computer }) => (
              <AsideRow
                key={`${key}#${item.id}`}
                kind="snoozed"
                item={item}
                computer={computer}
                onPick={onPick}
                time={
                  item.snoozedUntil !== undefined && {
                    text: snoozeWakeLabel(item.snoozedUntil, now),
                    icon: AlarmClockIcon,
                    title: `Wakes ${snoozeTimeLabel(item.snoozedUntil, now)}`,
                  }
                }
                action={onWake && { label: "Wake", icon: AlarmClockOffIcon, run: () => onWake(item.id) }}
              />
            ))}
          </ul>
        </ScrollArea>
      )}
    </section>
  );
}

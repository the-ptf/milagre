import { useState } from "react";
import { AlarmClockIcon, AlarmClockOffIcon } from "@hugeicons/core-free-icons";
import { snoozeTimeLabel, snoozeWakeLabel } from "@milagre/shared/snooze";
import { preferenceStorage as localStorage } from "../../lib/preference-storage.ts";
import { useDisplayNow } from "../../lib/display-clock";
import { ScrollArea } from "../primitives/ScrollArea";
import { AsideRow, AsideToggle } from "./DoneSection";
import type { RowComputer, SidebarRecent } from "./ChatRow";

export type SnoozedEntry = {
  key: string;
  item: SidebarRecent;
  onPick: (item: SidebarRecent) => void;
  onWake?: (id: string) => void;
  computer?: RowComputer;
};

const OPEN_KEY = "milagre.sidebarSnoozedOpen";

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

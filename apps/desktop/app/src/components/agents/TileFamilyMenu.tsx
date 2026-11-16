import { useRef, useState } from "react";
import { ArrowExpandDiagonal01Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { useDisplayNow } from "../../lib/display-clock";
import { familyMenuModel, type FamilyReads } from "../../lib/family-menu";
import { useRoutines } from "../../lib/routines";
import { Icon } from "../primitives/Icon";
import { MenuRow, MenuSeparator, Popover } from "../primitives/Popover";
import { FamilyRow } from "./FamilyMenu";

export interface TileMenuControls {
  reads: (chatKey: string) => Omit<FamilyReads, "routines" | "now">;
  onOpenAlone: (key: string) => void;
  onReplace: (tile: string, next: string) => void;
}

export function TileTitle({ chatKey, title, tiles, controls }: { chatKey: string; title: string; tiles: readonly string[]; controls: TileMenuControls }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { routines } = useRoutines();
  const now = useDisplayNow(1000, open);
  const model = open ? familyMenuModel(chatKey, { ...controls.reads(chatKey), routines, now }) : null;
  const rows = model ? [...model.ancestors, ...model.subchats].filter((entry) => !tiles.includes(entry.key)) : [];
  const close = () => setOpen(false);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-tile-menu
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${title}, Chat options`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        className="flex min-w-0 items-center gap-1 rounded-inline font-medium text-ink transition-colors hover:bg-hover focus-visible:outline-2"
      >
        <span className="min-w-0 truncate">{title}</span>
        <Icon icon={UnfoldMoreIcon} size={12} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <Popover anchor={trigger} align="start" width={288} label={`${title} options`} onClose={close} data-tile-family-menu>
          <MenuRow
            icon={ArrowExpandDiagonal01Icon}
            title="Open alone"
            data-tile-open-alone
            onClick={() => {
              close();
              controls.onOpenAlone(chatKey);
            }}
          />
          {rows.length > 0 && <MenuSeparator />}
          {rows.map((entry) => (
            <FamilyRow
              key={entry.key}
              entry={entry}
              onPick={(next) => {
                close();
                controls.onReplace(chatKey, next);
              }}
            />
          ))}
        </Popover>
      )}
    </>
  );
}

import { useRef, useState } from "react";
import { ArrowExpandDiagonal01Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { useDisplayNow } from "../../lib/display-clock";
import { familyMenuModel, type FamilyReads } from "../../lib/family-menu";
import { useRoutines } from "../../lib/routines";
import { Icon } from "../primitives/Icon";
import { MenuRow, MenuSeparator, Popover } from "../primitives/Popover";
import { FamilyRow } from "./FamilyMenu";

/** What a split tile's title menu does, held by App with one identity so the tiles keep their memo. */
export interface TileMenuControls {
  /** The sessions of the Chat's Project, the live runs and the open Delegations, as they stand when its menu opens. */
  reads: (chatKey: string) => Omit<FamilyReads, "routines" | "now">;
  /** Ends the split and shows the Chat alone. */
  onOpenAlone: (key: string) => void;
  /** The one explicit swap: `next` takes the place of the tile `tile`, so comparing siblings is one click. */
  onReplace: (tile: string, next: string) => void;
}

/**
 * A split tile's title. It opens a menu: "Open alone" first, then the Chats of its family that aren't on screen, with their
 * states in words; picking one replaces this tile. The only place a split changes its Chats on its own.
 */
export function TileTitle({
  chatKey,
  title,
  tiles,
  controls,
}: {
  chatKey: string;
  title: string;
  /** Every Chat the split shows: a family row for one of them would only duplicate a tile. */
  tiles: readonly string[];
  controls: TileMenuControls;
}) {
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
          // An unfocused tile focuses on a click; this one opens the menu instead.
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

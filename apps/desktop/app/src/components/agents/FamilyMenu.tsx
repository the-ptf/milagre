import type { RefObject } from "react";
import { GridViewIcon, LayoutTwoColumnIcon } from "@hugeicons/core-free-icons";
import type { FamilyEntry, FamilyMenuModel } from "../../lib/family-menu";
import { MenuLabel, MenuRow, MenuSeparator, Popover } from "../primitives/Popover";
import { ChatMarkDot } from "../sidebar/ChatRow";

/** One Chat of the family: its live dot, its title, and its state in words ("Parent · Working", "Needs you"). */
export function FamilyRow({ entry, open = false, onPick }: { entry: FamilyEntry; open?: boolean; onPick: (key: string) => void }) {
  return (
    <MenuRow
      // The open row has the tick and no fill, as every checked menu row does.
      role="menuitemradio"
      checked={open}
      data-family-chat={entry.key}
      icon={<ChatMarkDot mark={entry.mark} background={entry.background} />}
      title={entry.title}
      trailing={
        <span className="shrink-0 text-12 font-medium">
          {entry.role && <span className="font-normal text-ink-3">{entry.role} · </span>}
          <span className={entry.ink}>{entry.word}</span>
        </span>
      }
      onClick={() => onPick(entry.key)}
    />
  );
}

/**
 * The open Subchat's family: the Chats above it, then the family with live states and a tick on the open one, and the two
 * ways into a split. Picking a Chat opens it alone (App's openAlone); the open row only closes the menu.
 */
export function FamilyMenu({
  model,
  openKey,
  anchor,
  onPick,
  onBeside,
  onShowAll,
  onClose,
}: {
  model: FamilyMenuModel;
  openKey: string;
  anchor: RefObject<HTMLElement | null>;
  onPick: (key: string) => void;
  /** "Open beside parent"; left out when the open Chat has no parent listed. */
  onBeside?: () => void;
  onShowAll: () => void;
  onClose: () => void;
}) {
  const pick = (key: string) => {
    onClose();
    if (key !== openKey) onPick(key);
  };
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <Popover anchor={anchor} align="start" width={320} label="Chats in this family" onClose={onClose} data-family-menu>
      {model.ancestors.map((entry) => (
        <FamilyRow key={entry.key} entry={entry} onPick={pick} />
      ))}
      <MenuLabel>{model.subchats.length === 1 ? "1 Subchat" : `${model.subchats.length} Subchats`}</MenuLabel>
      {model.subchats.map((entry) => (
        <FamilyRow key={entry.key} entry={entry} open={entry.key === openKey} onPick={pick} />
      ))}
      <MenuSeparator />
      {onBeside && <MenuRow icon={LayoutTwoColumnIcon} title="Open beside parent" data-family-beside onClick={run(onBeside)} />}
      <MenuRow icon={GridViewIcon} title={`Show all ${model.size} side by side`} data-family-all onClick={run(onShowAll)} />
    </Popover>
  );
}

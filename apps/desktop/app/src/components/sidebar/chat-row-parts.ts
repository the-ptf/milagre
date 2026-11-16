import { type ReactNode } from "react";
import { CloudOffIcon, ComputerIcon, LaptopIcon } from "@hugeicons/core-free-icons";
import { type ArchivePlan } from "@/lib/archive";
import { HugeIconData } from "./ChatMarks";
import type { RowComputer } from "./ChatRow";

export const computerIcon = (computer: RowComputer) => (computer.offline ? CloudOffIcon : /studio|mini|imac/i.test(computer.name) ? ComputerIcon : LaptopIcon);

export const HIDE_ONLY: ArchivePlan = {
  milagreOwned: false,
  shared: false,
  status: null,
};

export const ROW_PR_LIMIT = 1;

export const HOVER_CARD_WIDTH = 256;

export const MENU_WIDTH = 240;

export const SUB_MENU_WIDTH = 200;

export type MenuEntry = {
  key: string;
  label: string;
  icon?: HugeIconData;
  leading?: ReactNode;
  hint?: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  sub?: { key: string; label: string; detail?: string; onSelect: () => void }[];
};

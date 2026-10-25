import type { ReactElement } from "react";
import type { IconData } from "./icons";
/** Searchable choices wait here because a native sheet route cannot carry callbacks. */
/** `keywords`: more text the search matches besides the title (the Link picker's Project and branch). */
/** `section` heads a run of rows (a computer's Projects); `leading` replaces the row's icon (its Project's icon). */
type ChoiceItem = {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  checked?: boolean;
  disabled?: boolean;
  section?: string;
  leading?: ReactElement;
};
/** `icon` replaces the leading branch icon on each row, and `leading` (a brand mark) replaces both; the default stays for branch and worktree pickers. */
type ChoiceRequest = {
  title: string;
  placeholder: string;
  emptyLabel: string;
  items: ChoiceItem[];
  icon?: IconData;
  leading?: ReactElement;
  /** Tabs over the list (Linear workspaces); `tab` is the one `items` came from. Shown only with two or more. */
  tabs?: { id: string; label: string }[];
  tab?: string;
  /** Reads a tab's items, from Linear again when `fresh`; given, the sheet refreshes on pull and shows a failure. */
  load?: (tab: string | undefined, fresh: boolean) => Promise<ChoiceItem[]>;
  onSelect: (id: string) => void;
};
type ChoiceRequestEntry = Omit<ChoiceRequest, "onSelect"> & { choose: (id: string | null) => void };

let current: ChoiceRequestEntry | null = null;
let present: (() => void) | null = null;

export function setChoicePresenter(open: () => void) {
  present = open;
}
export function currentChoice() {
  return current;
}

export function showChoiceSheet({ onSelect, load, ...request }: ChoiceRequest) {
  current?.choose(null);
  let done = false;
  const entry: ChoiceRequestEntry = {
    ...request,
    // A load replaces the entry's items, so a pick from the new list is still checked against what was shown.
    ...(load
      ? {
          load: async (tab, fresh) => {
            const items = await load(tab, fresh);
            entry.items = items;
            entry.tab = tab;
            return items;
          },
        }
      : {}),
    choose(id) {
      if (done) return;
      done = true;
      if (current === entry) current = null;
      if (id !== null && entry.items.some((item) => item.id === id && !item.disabled)) onSelect(id);
    },
  };
  current = entry;
  present?.();
}

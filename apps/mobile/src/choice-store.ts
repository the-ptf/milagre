import type { ReactElement } from "react";
import type { IconData } from "./icons";
/** Searchable choices wait here because a native sheet route cannot carry callbacks. */
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
type ChoiceRequest = {
  title: string;
  placeholder: string;
  emptyLabel: string;
  items: ChoiceItem[];
  icon?: IconData;
  leading?: ReactElement;
  tabs?: { id: string; label: string }[];
  tab?: string;
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

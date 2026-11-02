import { useSyncExternalStore } from "react";

/** The Settings row a search result opened: the section shows it lit up once its text renders. */
export type SettingsFindTarget = { section: string; title: string; nonce: number };

let target: SettingsFindTarget | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Asks `section` to scroll to and light up the row whose text is `title`; the same row again lights it again. */
export function findSetting(section: string, title: string) {
  target = { section, title, nonce: ++nonce };
  emit();
}

export function useSettingsFindTarget(): SettingsFindTarget | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => target,
  );
}

/**
 * The element in `root` showing exactly `title`: the deepest one whose whole text is the title, so a row's label wins
 * over the row around it. Hidden elements (a closed menu's options) don't count.
 */
export function findLabelElement(root: HTMLElement, title: string): HTMLElement | null {
  const wanted = title.trim();
  let found: HTMLElement | null = null;
  for (const element of root.querySelectorAll<HTMLElement>("h2, h3, span, p, div, label, button, legend")) {
    if (element.textContent?.trim() !== wanted) continue;
    if (element.closest("[hidden], [aria-hidden='true'], [inert]")) continue;
    // A later match inside this one is deeper; keep going until the innermost.
    if (!found || found.contains(element)) found = element;
    else break;
  }
  return found;
}

/** The row a label sits in: a Settings row or card heading when marked, else the label itself. */
export function rowOf(label: HTMLElement): HTMLElement {
  return label.closest<HTMLElement>("[data-settings-row]") ?? label;
}

import { useSyncExternalStore } from "react";

export type SettingsFindTarget = { section: string; title: string; nonce: number };

let target: SettingsFindTarget | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

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

export function findLabelElement(root: HTMLElement, title: string): HTMLElement | null {
  const wanted = title.trim();
  let found: HTMLElement | null = null;
  for (const element of root.querySelectorAll<HTMLElement>("h2, h3, span, p, div, label, button, legend")) {
    if (element.textContent?.trim() !== wanted) continue;
    if (element.closest("[hidden], [aria-hidden='true'], [inert]")) continue;
    if (!found || found.contains(element)) found = element;
    else break;
  }
  return found;
}

export function rowOf(label: HTMLElement): HTMLElement {
  return label.closest<HTMLElement>("[data-settings-row]") ?? label;
}

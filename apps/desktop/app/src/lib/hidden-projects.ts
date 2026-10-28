import { preferenceStorage as localStorage } from "./preference-storage.ts";
import { useEffect, useState } from "react";
import { RECENT_PROJECTS_CHANGED } from "./project-list.ts";

export const HIDDEN_REMOTE_SCOPES_KEY = "milagre.hiddenRemoteScopes";
const NONE: ReadonlySet<string> = new Set();

/** Other computers' Projects and Links hidden from this Mac's sidebar (`${computerId}|/path`, `milagre-link:${computerId}|uuid`). */
export function readHiddenRemoteScopes(): ReadonlySet<string> {
  try {
    const saved = JSON.parse(localStorage?.getItem(HIDDEN_REMOTE_SCOPES_KEY) ?? "[]");
    return Array.isArray(saved) ? new Set(saved.filter((item): item is string => typeof item === "string" && item.length > 0)) : NONE;
  } catch {
    return NONE;
  }
}

export function isRemoteScopeHidden(key: string): boolean {
  return readHiddenRemoteScopes().has(key);
}

export function setRemoteScopeHidden(key: string, hidden: boolean): void {
  const next = new Set(readHiddenRemoteScopes());
  if (hidden) next.add(key);
  else next.delete(key);
  try {
    if (next.size > 0) localStorage?.setItem(HIDDEN_REMOTE_SCOPES_KEY, JSON.stringify([...next]));
    else localStorage?.removeItem(HIDDEN_REMOTE_SCOPES_KEY);
  } catch {
    /* ignore storage errors */
  }
  if (typeof Event === "function") window.dispatchEvent?.(new Event(RECENT_PROJECTS_CHANGED));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

/** The Projects hidden from this Mac's sidebar (local and paired computers'), read again each time one is hidden or shown. */
export function useHiddenProjects(): ReadonlySet<string> {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => readHiddenRemoteScopes());
  useEffect(() => {
    let live = true;
    let localHidden: string[] = [];
    const sync = () => {
      const merged = new Set([...localHidden, ...readHiddenRemoteScopes()]);
      setHidden((previous) => (sameSet(previous, merged) ? previous : merged));
    };
    const read = () => {
      sync();
      void window.milagre
        ?.listRecentProjects?.()
        .then((list) => {
          if (!live || !Array.isArray(list)) return;
          localHidden = list.filter((project) => project.hidden).map((project) => project.path);
          sync();
        })
        .catch(() => {});
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === HIDDEN_REMOTE_SCOPES_KEY) sync();
    };
    read();
    window.addEventListener(RECENT_PROJECTS_CHANGED, read);
    window.addEventListener("storage", onStorage);
    return () => {
      live = false;
      window.removeEventListener(RECENT_PROJECTS_CHANGED, read);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return hidden;
}

const HIDDEN_COMPUTERS_KEY = "milagre.hiddenComputers";
const HIDDEN_COMPUTERS_CHANGED = "milagre:hidden-computers-changed";
// The last read, so useSyncExternalStore gets the same set until the saved list changes.
let computersRead: { raw: string | null; set: ReadonlySet<string> } = { raw: null, set: NONE };

/**
 * Computers whose Projects this Mac's sidebar leaves out (their ids, "local" for This Mac), unchecked in the computers
 * popover. Only what the sidebar lists: the computer stays paired and connected, and its Projects keep their own choices.
 */
export function readHiddenComputers(): ReadonlySet<string> {
  let raw: string | null = null;
  try {
    raw = localStorage?.getItem(HIDDEN_COMPUTERS_KEY) ?? null;
  } catch {
    /* ignore storage errors */
  }
  if (raw === computersRead.raw) return computersRead.set;
  let set = NONE;
  try {
    const saved = JSON.parse(raw ?? "[]");
    if (Array.isArray(saved)) set = new Set(saved.filter((item): item is string => typeof item === "string" && item.length > 0));
  } catch {
    /* a broken list hides nothing */
  }
  computersRead = { raw, set };
  return set;
}

export function setComputerHidden(id: string, hidden: boolean): void {
  const next = new Set(readHiddenComputers());
  if (hidden) next.add(id);
  else next.delete(id);
  try {
    if (next.size > 0) localStorage?.setItem(HIDDEN_COMPUTERS_KEY, JSON.stringify([...next]));
    else localStorage?.removeItem(HIDDEN_COMPUTERS_KEY);
  } catch {
    /* ignore storage errors */
  }
  if (typeof Event === "function") window.dispatchEvent?.(new Event(HIDDEN_COMPUTERS_CHANGED));
}

export function subscribeHiddenComputers(changed: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === HIDDEN_COMPUTERS_KEY) changed();
  };
  window.addEventListener(HIDDEN_COMPUTERS_CHANGED, changed);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(HIDDEN_COMPUTERS_CHANGED, changed);
    window.removeEventListener("storage", onStorage);
  };
}

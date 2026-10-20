import { useEffect, useState } from "react";
import { RECENT_PROJECTS_CHANGED } from "./project-list.ts";

export const HIDDEN_REMOTE_SCOPES_KEY = "milagre.hiddenRemoteScopes";
const NONE: ReadonlySet<string> = new Set();

/** Other computers' Projects and Links hidden from this Mac's sidebar (`${computerId}|/path`, `milagre-link:${computerId}|uuid`). */
export function readHiddenRemoteScopes(): ReadonlySet<string> {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(HIDDEN_REMOTE_SCOPES_KEY) ?? "[]");
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
    if (next.size > 0) globalThis.localStorage?.setItem(HIDDEN_REMOTE_SCOPES_KEY, JSON.stringify([...next]));
    else globalThis.localStorage?.removeItem(HIDDEN_REMOTE_SCOPES_KEY);
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

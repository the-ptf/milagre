import { useEffect } from "react";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { bridgeFor } from "./computer-bridge";
import { RECENT_PROJECTS_CHANGED } from "./project-list";

/** Calls `changed` when this Mac's recent Projects may have changed: an open, a removal, a local MCP add or a new sidebar limit. */
export function useRecentProjectsChanged(changed: () => void) {
  useEffect(() => {
    window.addEventListener(RECENT_PROJECTS_CHANGED, changed);
    const stopLocalMcp = bridgeFor(LOCAL_COMPUTER).localMcp?.onChanged?.((payload) => {
      if (payload?.projectAdded) window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
    });
    const stopSidebarSettings = window.milagre?.onSidebarSettings?.(changed);
    return () => {
      window.removeEventListener(RECENT_PROJECTS_CHANGED, changed);
      stopLocalMcp?.();
      stopSidebarSettings?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribes once; callers pass a state setter that never changes.
  }, []);
}

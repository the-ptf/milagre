import { useMemo, useRef } from "react";
import type { ArchiveMode, ArchivePlan } from "@/lib/archive";
import { useRoutines } from "../../lib/routines";
import { cachedProjectCopy, heartbeatKeys, heartbeatLines, withHeartbeats, type useScopeStates } from "../../lib/sidebar-scopes";
import { bridgeForKey, isRemoteKey } from "../../lib/computer-bridge";
import { pinChat } from "../../lib/chat-pins";
import { keepsOnPin } from "@milagre/shared/chat-pins";
import { patchChatShowingDone } from "../../lib/done-pending";
import { snoozeChat } from "../../lib/snooze-pending";
import type { ChatRowActions, SidebarRecent } from "./ChatRow";
import { openDesignLibrary } from "../../lib/design-library-page";

type ScopeRowHandlesProps = {
  scopeStates: ReturnType<typeof useScopeStates>["states"];
  scopeChatActions?: (key: string, gitless: boolean) => ChatRowActions;
  onScopeArchiveCheck?: (key: string, id: string) => Promise<ArchivePlan>;
  onScopeArchive?: (key: string, id: string, mode: ArchiveMode, plan: ArchivePlan) => void;
  onOpenScopeChat?: (key: string, id: string) => void;
  onHoverChat?: (key: string, id: string) => void;
};

export function useScopeRowHandles({ scopeStates, scopeChatActions, onScopeArchiveCheck, onScopeArchive, onOpenScopeChat, onHoverChat }: ScopeRowHandlesProps) {
  const { routines } = useRoutines();
  const beatKeys = useMemo(() => heartbeatKeys(routines), [routines]);
  const beats = useMemo(() => heartbeatLines(beatKeys), [beatKeys]);
  const markedRows = useRef(new Map<string, { rows: SidebarRecent[]; keys: string; marked: SidebarRecent[] }>());
  const withBeats = (scopeKey: string, rows: SidebarRecent[]) => {
    const hit = markedRows.current.get(scopeKey);
    if (hit && hit.rows === rows && hit.keys === beatKeys) return hit.marked;
    const marked = withHeartbeats(scopeKey, rows, beats);
    markedRows.current.set(scopeKey, { rows, keys: beatKeys, marked });
    return marked;
  };
  const scopeActions = useRef(new Map<string, ChatRowActions>());
  const scopeSessions = useRef(scopeStates);
  scopeSessions.current = scopeStates;
  const scopeArchive = useRef({ check: onScopeArchiveCheck, archive: onScopeArchive });
  scopeArchive.current = { check: onScopeArchiveCheck, archive: onScopeArchive };
  const actionsFor = (key: string, gitless = false) => {
    const cacheKey = gitless ? `gitless\n${key}` : key;
    let actions = scopeActions.current.get(cacheKey);
    if (!actions) {
      const archivable = !key.startsWith("milagre-link:") && !!onScopeArchiveCheck && !!onScopeArchive;
      actions = {
        ...scopeChatActions?.(key, gitless),
        remote: isRemoteKey(key),
        ...(gitless ? { gitless: true } : {}),
        onPin: (id, order) => {
          const state = scopeSessions.current[key] ?? cachedProjectCopy(key)?.state;
          pinChat(key, Object.values(state?.sessions ?? {}), Number(id), order ?? null);
          if (order != null && keepsOnPin(state?.sessions[Number(id)]))
            void bridgeForKey(key)
              .patchChat(key, Number(id), { kept: true })
              .catch(() => {});
        },
        onDone: (id) => void patchChatShowingDone(key, Number(id), { done: true, unread: false }).catch(() => {}),
        onReopen: (id) => void patchChatShowingDone(key, Number(id), { done: false }).catch(() => {}),
        onSnooze: (id, until) => void snoozeChat(key, Number(id), until).catch(() => {}),
        onWake: (id) => void snoozeChat(key, Number(id), null).catch(() => {}),
        ...(key.startsWith("milagre-link:") ? {} : { onDesignLibrary: () => openDesignLibrary(key) }),
        ...(archivable
          ? {
              onArchiveCheck: (id: string) => scopeArchive.current.check!(key, id),
              onArchive: (id: string, mode: ArchiveMode, plan: ArchivePlan) => scopeArchive.current.archive!(key, id, mode, plan),
            }
          : {}),
      };
      scopeActions.current.set(cacheKey, actions);
    }
    return actions;
  };
  const scopePickers = useRef(new Map<string, (item: SidebarRecent) => void>());
  const pickerFor = (key: string) => {
    let pick = scopePickers.current.get(key);
    if (!pick) {
      pick = (item) => openScope.current(key, item.id);
      scopePickers.current.set(key, pick);
    }
    return pick;
  };
  const openScope = useRef((key: string, id: string) => onOpenScopeChat?.(key, id));
  openScope.current = (key: string, id: string) => onOpenScopeChat?.(key, id);
  const hoverScope = useRef((key: string, id: string) => onHoverChat?.(key, id));
  hoverScope.current = (key: string, id: string) => onHoverChat?.(key, id);
  const scopeHovers = useRef(new Map<string, (item: SidebarRecent) => void>());
  const hoverFor = (key: string) => {
    let hover = scopeHovers.current.get(key);
    if (!hover) {
      hover = (item) => hoverScope.current(key, item.id);
      scopeHovers.current.set(key, hover);
    }
    return hover;
  };
  return { withBeats, actionsFor, pickerFor, hoverFor };
}

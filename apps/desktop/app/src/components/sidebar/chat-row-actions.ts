import { type ChatRowActions, type SidebarRecent } from "./ChatRow";
import { pinOrderAt } from "@/lib/chat-list";
import { useSidebarLinks } from "./SidebarLinks";
import { undoHistory, type UndoAction } from "../../lib/undo-history";
import { DELETE_UNDO_MS } from "@milagre/shared/archive";
import { inSnoozed } from "../../lib/snooze-pending";

export type RowActionsNow = { recents: SidebarRecent[]; actions: ChatRowActions; sidebarLinks: ReturnType<typeof useSidebarLinks> };

const doneStep = (actions: () => ChatRowActions, id: string): UndoAction => ({
  text: "Moved to Done",
  kind: "done",
  undoneText: "Back in Chats",
  undo: () => actions().onReopen?.(id),
  redo: () => actions().onDone?.(id),
});

const reopenStep = (actions: () => ChatRowActions, id: string): UndoAction => ({
  text: "Back in Chats",
  kind: "undone",
  undoneText: "Moved to Done",
  undoneKind: "done",
  undo: () => actions().onDone?.(id),
  redo: () => actions().onReopen?.(id),
});

const reopeners = new WeakMap<ChatRowActions, (id: string) => void>();

export function reopenFromDone(actions: ChatRowActions) {
  let reopen = reopeners.get(actions);
  if (!reopen) {
    reopen = (id) => {
      actions.onReopen?.(id);
      undoHistory.record(reopenStep(() => actions, id));
    };
    reopeners.set(actions, reopen);
  }
  return reopen;
}

const snoozeStep = (actions: () => ChatRowActions, id: string, until: number): UndoAction => ({
  text: "Snoozed",
  undoneText: "Back in Chats",
  undo: () => actions().onWake?.(id),
  redo: () => actions().onSnooze?.(id, until),
});

const wakers = new WeakMap<ChatRowActions, (id: string) => void>();

export function wakeFromSnoozed(actions: ChatRowActions) {
  let wake = wakers.get(actions);
  if (!wake) {
    wake = (id) => actions.onWake?.(id);
    wakers.set(actions, wake);
  }
  return wake;
}

export function withoutSetAside(rows: SidebarRecent[]): SidebarRecent[] {
  return rows.some((row) => row.doneAt || inSnoozed(row)) ? rows.filter((row) => !row.doneAt && !inSnoozed(row)) : rows;
}

export function chatRowActions(actions: ChatRowActions, linkProjectId: string | null, scopeKey: string, now: () => RowActionsNow): ChatRowActions {
  return {
    ...actions,
    onPin:
      actions.onPin &&
      ((id, order) => {
        const latest = now();
        const item = latest.recents.find((row) => row.id === id);
        if (!item || !latest.actions.onPin) return;
        const orders = latest.recents.filter((row) => row.pinned && row.id !== id).map((row) => row.pinOrder ?? 0);
        const next = order === undefined ? pinOrderAt(orders, orders.length) : order;
        const previous = item.pinned ? (item.pinOrder ?? 0) : null;
        latest.actions.onPin(id, next);
        if ((previous === null) !== (next === null))
          undoHistory.record({
            text: next === null ? "Unpinned" : "Pinned",
            undoneText: next === null ? "Pinned" : "Unpinned",
            undo: () => now().actions.onPin?.(id, previous),
            redo: () => now().actions.onPin?.(id, next),
          });
      }),
    onDone:
      actions.onDone &&
      ((id) => {
        const latest = now().actions;
        if (!latest.onDone) return;
        latest.onDone(id);
        undoHistory.record(doneStep(() => now().actions, id));
      }),
    onReopen:
      actions.onReopen &&
      ((id) => {
        const latest = now().actions;
        if (!latest.onReopen) return;
        latest.onReopen(id);
        undoHistory.record(reopenStep(() => now().actions, id));
      }),
    onSnooze:
      actions.onSnooze &&
      ((id, until) => {
        const latest = now().actions;
        if (!latest.onSnooze) return;
        latest.onSnooze(id, until);
        undoHistory.record(snoozeStep(() => now().actions, id, until));
      }),
    onArchive:
      actions.onArchive &&
      ((id, mode, plan) => {
        const latest = now().actions;
        const work = latest.onArchive?.(id, mode, plan);
        if (!latest.onUndoArchive) undoHistory.notify("Chat deleted");
        else
          undoHistory.record({
            text: "Chat deleted",
            kind: "deleted",
            undoneText: "Chat restored",
            undo: () => now().actions.onUndoArchive?.(id) ?? false,
            undoWindowMs: DELETE_UNDO_MS,
          });
        return work;
      }),
    ...(linkProjectId
      ? {
          onLinkWith: (id: string, anchor: { top: number; left: number }) => {
            const item = now().recents.find((row) => row.id === id);
            if (item) now().sidebarLinks.pick({ scopeKey, item }, anchor, "link");
          },
          onRemoveLink: (id: string, anchor: { top: number; left: number }) => {
            const item = now().recents.find((row) => row.id === id);
            if (item) now().sidebarLinks.pick({ scopeKey, item }, anchor, "remove");
          },
        }
      : {}),
  };
}

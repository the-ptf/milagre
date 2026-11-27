import type { ChatRowActions, SidebarRecent } from "./ChatRow";
import { pinOrderAt } from "../../lib/chat-list.ts";
import type { useSidebarLinks } from "./SidebarLinks";
import { undoHistory, type UndoAction } from "../../lib/undo-history.ts";
import { DELETE_UNDO_MS, type ArchivePlan } from "@milagre/shared/archive";
import { inSnoozed } from "../../lib/snooze-pending.ts";
import { chatOf, foldTabbedChats, strongestMark, tabId } from "@milagre/shared/workspace-tabs";
import { tabSet } from "../../lib/workspace-tabs-store.ts";

export type RowActionsNow = { recents: SidebarRecent[]; actions: ChatRowActions; sidebarLinks: ReturnType<typeof useSidebarLinks> };

const doneStep = (actions: () => ChatRowActions, ids: string[]): UndoAction => ({
  text: "Moved to Done",
  kind: "done",
  undoneText: "Back in Chats",
  undo: () => ids.forEach((id) => actions().onReopen?.(id)),
  redo: () => ids.forEach((id) => actions().onDone?.(id)),
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

const snoozeStep = (actions: () => ChatRowActions, ids: string[], until: number): UndoAction => ({
  text: "Snoozed",
  undoneText: "Back in Chats",
  undo: () => ids.forEach((id) => actions().onWake?.(id)),
  redo: () => ids.forEach((id) => actions().onSnooze?.(id, until)),
});

const NO_WORKTREE: ArchivePlan = { milagreOwned: false, shared: true, status: null };

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

/**
 * The sidebar while Workspace tabs are on: one row per Worktree or Link, its main Chat's, showing what its other Chats
 * (now only tabs) are doing. Done and Snoozed rows stay as they are, so each can be reopened on its own.
 */
export function foldTabRows<T extends SidebarRecent>(rows: T[], on: boolean): T[] {
  if (!on) return rows;
  return foldTabbedChats(
    rows,
    (row) =>
      row.tabSet && !row.doneAt && !inSnoozed(row)
        ? { id: Number(row.id), group: row.tabSet, ...(row.parent === undefined ? {} : { parent: Number(row.parent) }) }
        : null,
    (main, tabs) => ({
      ...main,
      mark: strongestMark([main.mark, ...tabs.map((tab) => tab.mark)]),
      unread: Boolean(main.unread || tabs.some((tab) => tab.unread)),
      pending: Boolean(main.pending || tabs.some((tab) => tab.pending)),
      background: tabs.reduce((total, tab) => total + (tab.background ?? 0), main.background ?? 0) || undefined,
      tabChats: tabs.map((tab) => tab.id),
    }),
  );
}

/** Whether a row shows `chatId`: its own Chat, or one folded into it as a tab. */
export const isRowOf = (row: Pick<SidebarRecent, "id" | "tabChats">, chatId: string | null) =>
  row.id === chatId || (chatId !== null && !!row.tabChats?.includes(chatId));

/** A row's Chat and the Chats folded into it, for actions that cover the whole Worktree. */
const rowChats = (row: Pick<SidebarRecent, "id" | "tabChats"> | undefined, id: string) => [id, ...(row?.tabChats ?? [])];

/** The Chat a folded row opens: the one whose tab (or page) was in front when its Worktree was last shown, else its own. */
export function frontChat(row: Pick<SidebarRecent, "id" | "tabSet" | "tabChats">): string {
  if (!row.tabSet || !row.tabChats?.length) return row.id;
  const set = tabSet(row.tabSet);
  const front = set.tabs.find((tab) => tabId(tab) === set.active);
  const chat = front ? chatOf(front) : undefined;
  return chat !== undefined && row.tabChats.includes(String(chat)) ? String(chat) : row.id;
}

/**
 * The sidebar rows' actions with their Undo steps. A row that stands for a Worktree (its tabs folded into it) is Done,
 * Snoozed or Deleted with all its Chats, as one step.
 */
export function chatRowActions(actions: ChatRowActions, linkProjectId: string | null, scopeKey: string, now: () => RowActionsNow): ChatRowActions {
  const family = (id: string) =>
    rowChats(
      now().recents.find((row) => row.id === id),
      id,
    );
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
        const ids = family(id);
        ids.forEach((chat) => latest.onDone?.(chat));
        undoHistory.record(doneStep(() => now().actions, ids));
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
        const ids = family(id);
        ids.forEach((chat) => latest.onSnooze?.(chat, until));
        undoHistory.record(snoozeStep(() => now().actions, ids, until));
      }),
    onArchiveCheck: actions.onArchiveCheck && ((id) => now().actions.onArchiveCheck!(id, family(id).slice(1))),
    onArchive:
      actions.onArchive &&
      ((id, mode, plan) => {
        const latest = now().actions;
        const [, ...tabs] = family(id);
        const work = Promise.all([...tabs.map((tab) => latest.onArchive?.(tab, "hide", NO_WORKTREE)), latest.onArchive?.(id, mode, plan, tabs)]);
        const text = tabs.length ? `${tabs.length + 1} Chats deleted` : "Chat deleted";
        if (!latest.onUndoArchive) undoHistory.notify(text);
        else
          undoHistory.record({
            text,
            kind: "deleted",
            undoneText: tabs.length ? "Chats restored" : "Chat restored",
            undo: () => [id, ...tabs].map((chat) => now().actions.onUndoArchive?.(chat) ?? false).some(Boolean),
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

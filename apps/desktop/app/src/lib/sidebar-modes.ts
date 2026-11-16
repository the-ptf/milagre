import type { ChatList } from "@milagre/shared/chat-display";

type SidebarModeInput = { collapsed: boolean; chatList: ChatList; currentKey: string; scopeCount: number };

export function sidebarModes({ collapsed, chatList, currentKey, scopeCount }: SidebarModeInput) {
  const showAll = !collapsed;
  const oneList = chatList === "list" && !!currentKey;
  return {
    showAll,
    oneList,
    buildGroups: showAll || oneList,
    bySection: showAll && !oneList,
    tree: chatList === "tree",
    railByScope: collapsed && !oneList && scopeCount > 1,
    railByChat: collapsed && oneList,
  };
}

export function splitGroupRows<Row extends { pinned?: boolean; doneAt?: number | null }>(all: Row[], rows: Row[], isSnoozed: (row: Row) => boolean) {
  return {
    pinned: rows.filter((row) => row.pinned),
    rest: rows.filter((row) => !row.pinned),
    done: all.filter((row) => row.doneAt),
    snoozed: all.filter(isSnoozed),
  };
}

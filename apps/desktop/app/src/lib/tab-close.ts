import { TAB_DONE_TEXT } from "@milagre/shared/workspace-tabs";
import { bridgeForKey } from "./computer-bridge.ts";
import { patchChatShowingDone } from "./done-pending.ts";
import { undoHistory } from "./undo-history.ts";

/**
 * Closing the tab of a Chat that lives only as a tab: the Chat moves to Done (its turn stopped first when `stop`), and
 * the toast's Undo brings it back, which gives it its tab again.
 */
export function setTabChatAside(scopeKey: string, chatId: number, stop: boolean) {
  const key = `${scopeKey}#${chatId}`;
  if (stop)
    void bridgeForKey(key)
      .interruptAgent(key)
      .catch(() => {});
  const done = () => void patchChatShowingDone(scopeKey, chatId, { done: true, unread: false }).catch(() => {});
  done();
  undoHistory.record({
    text: TAB_DONE_TEXT,
    kind: "done",
    undoneText: "Back in its tab",
    undo: () => void patchChatShowingDone(scopeKey, chatId, { done: false }).catch(() => {}),
    redo: done,
  });
}

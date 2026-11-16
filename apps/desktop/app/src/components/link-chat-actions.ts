import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import type { MilagreBridge } from "../electron";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { ChatRowActions } from "./sidebar/ChatRow";

export function linkConversationActions(
  bridge: MilagreBridge,
  owner: string,
  pick: (id: number) => void,
  error: (text: string) => void,
  notice: (text: string) => void,
): Pick<ChatRowActions, "onRename" | "onFork" | "onMarkUnread" | "onReload"> {
  return {
    onRename: (id, title) => void bridge.patchChat(owner, Number(id), { title }).catch((cause) => error(ipcErrorMessage(cause))),
    onMarkUnread: (id, unread) => void bridge.patchChat(owner, Number(id), { unread }),
    onFork: (id) =>
      void bridge
        .forkChat(owner, Number(id))
        .then((result) => pick(result.sessionId))
        .catch((cause) => error(ipcErrorMessage(cause))),
    onReload: (id) =>
      void bridge
        .reloadChat(`${owner}#${id}`)
        .then(() => notice("Chat reloaded. Your next message starts a fresh agent."))
        .catch((cause) => error(ipcErrorMessage(cause))),
  };
}

export function linkConversationTarget(owner: string, pick: (id: number) => void, open: (scope: string, id: number) => void) {
  return (key: string) => {
    const scope = projectOfKey(key);
    const id = sessionIdFromKey(key);
    if (scope === owner) pick(id);
    else open(scope, id);
  };
}

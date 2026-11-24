import { doneFromReply } from "@milagre/shared/done";
import type { AgentSession, ChatMessage } from "@milagre/shared/model";
import { undoHistory } from "@milagre/shared/undo-history";

type Caller = { call<T>(method: string, args?: unknown[]): Promise<T> };

/** The reply that carries the Done button: the Chat's last message, once the agent is idle and nothing waits to run. */
export function doneReplyId(
  chat: AgentSession | null | undefined,
  messages: readonly ChatMessage[],
  busy: { run: unknown; pending: unknown; offline: boolean },
) {
  const last = messages.at(-1);
  const idle = !busy.run && !busy.pending && !busy.offline;
  return idle && doneFromReply(chat) && last?.role === "assistant" ? last.id : undefined;
}

export async function markChatDone({
  client,
  projectPath,
  chat,
  action,
  leave,
}: {
  client: Caller;
  projectPath: string;
  chat: AgentSession;
  action: (work: () => Promise<unknown>) => Promise<boolean>;
  leave: () => void;
}) {
  const patch = (done: boolean) => () => client.call("chat:patch", [projectPath, chat.id, { done, ...(done ? { unread: false } : {}) }]);
  if (!(await action(patch(true)))) return;
  leave();
  undoHistory.record({
    text: "Moved to Done",
    kind: "done",
    undoneText: "Back in Chats",
    place: "chat",
    undo: () => void action(patch(false)),
    redo: () => void action(patch(true)),
  });
}

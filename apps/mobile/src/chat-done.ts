import { doneFromReply } from "@milagre/shared/done";
import type { AgentSession, ChatMessage } from "@milagre/shared/model";
import { undoHistory } from "@milagre/shared/undo-history";
import { TAB_DONE_TEXT } from "@milagre/shared/workspace-tabs";
import { markSettled } from "./settled-marks.ts";
import type { SettleActions } from "./settle-drag";

type Caller = { url?: string; call<T>(method: string, args?: unknown[]): Promise<T> };

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

type Settle = {
  client: Caller;
  projectPath: string;
  chat: AgentSession;
  action: (work: () => Promise<unknown>) => Promise<boolean>;
  leave: () => void;
};

export async function markChatDone({ client, projectPath, chat, action, leave }: Settle, arrived?: Promise<void>) {
  const patch = (done: boolean) => () => client.call("chat:patch", [projectPath, chat.id, { done, ...(done ? { unread: false } : {}) }]);
  const accepted = action(patch(true));
  if (arrived) {
    await arrived;
    markSettled(client.url ?? "", projectPath, chat.id, Date.now());
    leave();
  }
  if (!(await accepted)) {
    if (arrived) markSettled(client.url ?? "", projectPath, chat.id, null);
    return false;
  }
  if (!arrived) leave();
  undoHistory.record({
    text: "Moved to Done",
    kind: "done",
    undoneText: "Back in Chats",
    place: "chat",
    undo: () => void action(patch(false)),
    redo: () => void action(patch(true)),
  });
  return true;
}

async function snoozeChat({ client, projectPath, chat, action, leave }: Settle, until: number) {
  const patch = (snoozed: number | false) => () => client.call("chat:patch", [projectPath, chat.id, { snoozed_until: snoozed }]);
  if (!(await action(patch(until)))) return;
  leave();
  undoHistory.record({
    text: "Snoozed",
    undoneText: "Back in Chats",
    place: "chat",
    undo: () => void action(patch(false)),
    redo: () => void action(patch(until)),
  });
}

/** What the composer's pull-up settles, or nothing when the Chat's last reply can't be settled yet. */
export function settleActions(
  reply: { chat: AgentSession | null | undefined; messages: readonly ChatMessage[]; busy: Parameters<typeof doneReplyId>[2] },
  settle: Omit<Settle, "chat">,
): SettleActions | undefined {
  const { chat } = reply;
  if (!chat || doneReplyId(chat, reply.messages, reply.busy) === undefined) return undefined;
  return { done: (arrived) => markChatDone({ ...settle, chat }, arrived), snooze: (until) => void snoozeChat({ ...settle, chat }, until) };
}

/**
 * Closing the tab of a Chat that lives only as a tab: its turn stops, it moves to Done (at once in the list), and the
 * toast's Undo brings it back with its tab. `tab` opens or closes that tab.
 */
export async function closeTabIntoDone({
  client,
  projectPath,
  chatId,
  running,
  tab,
}: {
  client: Caller;
  projectPath: string;
  chatId: number;
  running: boolean;
  tab: (open: boolean) => void;
}) {
  const hostId = client.url ?? "";
  const settle = (done: boolean) => {
    markSettled(hostId, projectPath, chatId, done ? Date.now() : null);
    tab(!done);
    return client.call("chat:patch", [projectPath, chatId, { done, ...(done ? { unread: false } : {}) }]);
  };
  try {
    if (running) await client.call("agent:interrupt", [`${projectPath}#${chatId}`]).catch(() => {});
    await settle(true);
  } catch {
    markSettled(hostId, projectPath, chatId, null);
    tab(true);
    return false;
  }
  undoHistory.record({
    text: TAB_DONE_TEXT,
    kind: "done",
    undoneText: "Back in Chats",
    place: "chat",
    undo: () => void settle(false).catch(() => {}),
    redo: () => void settle(true).catch(() => {}),
  });
  return true;
}

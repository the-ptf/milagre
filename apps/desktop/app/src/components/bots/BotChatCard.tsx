import { GitBranchIcon } from "@hugeicons/core-free-icons";
import type { BotChatRecord } from "@milagre/shared/bots";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";

export const BOT_CHAT_STATUS: Record<BotChatRecord["status"], string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  "taken-over": "Yours",
};

export const projectLabel = (projectPath: string) => projectPath.split(/[\\/]/).findLast(Boolean) ?? projectPath;

/** A Milagre Chat the bot opened, as its thread shows it: title, Project and how it stands, and Open Chat. */
export function BotChatCard({
  chat,
  onOpen,
}: {
  chat: Pick<BotChatRecord, "chatKey" | "title" | "projectPath" | "status">;
  onOpen: (chatKey: string) => void;
}) {
  return (
    <div data-bot-chat-card={chat.chatKey} className="flex w-full max-w-md items-center gap-3 rounded-card border border-line bg-surface px-3 py-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-field text-ink-2">
        <Icon icon={GitBranchIcon} size={16} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-13 font-semibold text-ink">{chat.title}</span>
        <span className="truncate text-12 text-ink-3">
          {projectLabel(chat.projectPath)} · {BOT_CHAT_STATUS[chat.status]}
        </span>
      </span>
      <Button variant="ghost" size={28} onClick={() => onOpen(chat.chatKey)}>
        Open Chat
      </Button>
    </div>
  );
}

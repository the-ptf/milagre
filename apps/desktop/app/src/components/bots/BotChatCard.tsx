import { HugeiconsIcon } from "@hugeicons/react";
import { GitBranchIcon } from "@hugeicons/core-free-icons";
import type { BotChatRecord } from "@milagre/shared/bots";

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
    <div data-bot-chat-card={chat.chatKey} className="flex w-full max-w-md items-center gap-3 rounded-[12px] border border-line bg-surface px-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-field text-ink-2">
        <HugeiconsIcon icon={GitBranchIcon} size={15} strokeWidth={1.8} color="currentColor" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-semibold text-ink">{chat.title}</span>
        <span className="truncate text-[12px] text-ink-3">
          {projectLabel(chat.projectPath)} · {BOT_CHAT_STATUS[chat.status]}
        </span>
      </span>
      <button
        type="button"
        onClick={() => onOpen(chat.chatKey)}
        className="shrink-0 rounded-[8px] px-2 py-1 text-[13px] font-semibold text-ink transition-colors hover:bg-hover"
      >
        Open Chat
      </button>
    </div>
  );
}

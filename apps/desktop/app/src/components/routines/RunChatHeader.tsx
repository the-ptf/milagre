import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { runChatMeta } from "@milagre/shared/routines";
import Tooltip from "../primitives/Tooltip";
import { useRoutines } from "../../lib/routines";

/** What replying to a hidden Run Chat does, under the composer of the Run Chat pane. */
export const RUN_CHAT_REPLY_NOTE = "Replying keeps this Chat: it joins your sidebar and stays in this Routine's Runs.";

/**
 * The header of the Run Chat pane beside a Routine's page: the Chat's title, the Run's meta ("Run at 11:47 · acted in
 * 38 s · main") and Close.
 */
export function RunChatHeader({ chatKey, title, branch, onClose }: { chatKey: string; title: string; branch?: string; onClose: () => void }) {
  const { routines } = useRoutines();
  const run = routines.flatMap((routine) => routine.runs).find((entry) => entry.chatId === chatKey);
  return (
    <header data-run-chat-header={chatKey} className="flex shrink-0 items-center gap-3 border-b border-line py-2.5 pr-2.5 pl-4">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h2 className="truncate text-[15px] leading-5 font-semibold text-ink">{title}</h2>
        <p data-run-chat-meta className="truncate text-[12px] text-ink-3">
          {run ? runChatMeta(run, branch) : (branch ?? "")}
        </p>
      </div>
      <Tooltip label="Close" side="bottom">
        <button
          type="button"
          aria-label="Close"
          data-run-chat-close
          onClick={onClose}
          className="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.8} color="currentColor" />
        </button>
      </Tooltip>
    </header>
  );
}

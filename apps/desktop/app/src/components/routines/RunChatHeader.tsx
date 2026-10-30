import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { runChatMeta } from "@milagre/shared/routines";
import Tooltip from "../primitives/Tooltip";
import { IconButton } from "../primitives/Button";
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
    <header data-run-chat-header={chatKey} className="flex shrink-0 items-center gap-3 border-b border-line py-2 pr-2 pl-4">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h2 className="truncate text-15 font-semibold text-ink">{title}</h2>
        <p data-run-chat-meta className="truncate text-12 text-ink-3">
          {run ? runChatMeta(run, branch) : (branch ?? "")}
        </p>
      </div>
      <Tooltip label="Close" side="bottom">
        <IconButton label="Close" icon={Cancel01Icon} data-run-chat-close onClick={onClose} />
      </Tooltip>
    </header>
  );
}

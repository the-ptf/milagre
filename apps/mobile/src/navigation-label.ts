import type { ChatMessage } from "@milagre/shared/model";
import { messageSender } from "@milagre/shared/advisor-result";
import { babysitStoppedText, isBabysitStopped } from "@milagre/shared/babysit";
import { isCheckpointRestore } from "@milagre/shared/checkpoint-restore";
import { RELOAD_TEXT, isChatReload } from "@milagre/shared/chat-reload";
import { compactionText, isCompaction } from "@milagre/shared/compaction";
import { isHandoff } from "@milagre/shared/handoff";
import { mergedRoutineRunText, routineRunOf, routineRunText } from "@milagre/shared/routines";
import { accountSwitchText, isAccountSwitch, isLimitReset, limitResetText } from "@milagre/shared/usage-limit";
import { isValidation } from "@milagre/shared/validation";
import { isWorktreeLinked, worktreeLinkText } from "@milagre/shared/worktree-link";
import { handoffSides } from "./handoff-sides";

/** What VoiceOver's message navigation reads for one transcript entry: "Go to Undid 2 files, 4 of 9." */
export function navigationLabel(
  message: ChatMessage,
  merged: Parameters<typeof mergedRoutineRunText>[0] | undefined,
  position: string,
  handoffModels: { id: string; name: string }[],
): string {
  const run = routineRunOf(message);
  return isHandoff(message)
    ? `Go to ${handoffSides(message.context, handoffModels).restored ? "context restored" : "context handoff"} ${position}.`
    : isWorktreeLinked(message)
      ? `Go to ${worktreeLinkText(message.context)}, ${position}.`
      : isCompaction(message)
        ? `Go to ${compactionText(message.context)}, ${position}.`
        : isAccountSwitch(message)
          ? `Go to ${accountSwitchText(message.context)}, ${position}.`
          : isLimitReset(message)
            ? `Go to ${limitResetText()}, ${position}.`
            : isChatReload(message)
              ? `Go to ${RELOAD_TEXT}, ${position}.`
              : isBabysitStopped(message)
                ? `Go to ${babysitStoppedText(message.context).replace(/\.$/, "")}, ${position}.`
                : run
                  ? `Go to ${merged ? mergedRoutineRunText(merged) : routineRunText(run)}, ${position}.`
                  : isCheckpointRestore(message) || isValidation(message)
                    ? `Go to ${message.body}, ${position}.`
                    : `Go to ${messageSender(message)} message ${position}. ${message.body.slice(0, 88)}`;
}

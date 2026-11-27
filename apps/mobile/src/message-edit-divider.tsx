import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type { ChatMessage, MessageEditContext } from "@milagre/shared/model";
import { isMessageEdit, messageEditText } from "@milagre/shared/message-edit";
import { isCheckpointRestore } from "@milagre/shared/checkpoint-restore";
import { CheckpointRestoreDivider } from "./checkpoint-restore-divider";
import { PillButton } from "./primitives/pill-button";
import { TranscriptDivider } from "./primitives/transcript-divider";

/** Where a sent message was edited, as on desktop: "Edited · removed 3 messages · undid 3 files", with Redo for the files. */
export function MessageEditDivider({ context, onPreview }: { context: MessageEditContext; onPreview?: (recoveryId: string, action: "Undo" | "Redo") => void }) {
  const recoveryId = context.recoveryId;
  return (
    <TranscriptDivider
      label={messageEditText(context)}
      icon={PencilEdit02Icon}
      trailing={
        onPreview &&
        recoveryId && (
          <PillButton
            size="small"
            variant="secondary"
            title="Redo"
            accessibilityLabel="Redo: preview the files first"
            onPress={() => onPreview(recoveryId, "Redo")}
          />
        )
      }
    />
  );
}

/** The transcript lines where files were written back: Undo changes, and an edited message. Null for any other message. */
export function checkpointLine(message: ChatMessage, onPreview?: (recoveryId: string, action: "Undo" | "Redo") => void) {
  if (isCheckpointRestore(message)) return <CheckpointRestoreDivider context={message.context} onPreview={onPreview} />;
  if (isMessageEdit(message)) return <MessageEditDivider context={message.context} onPreview={onPreview} />;
  return null;
}

import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type { MessageEditContext } from "@milagre/shared/model";
import { messageEditText } from "@milagre/shared/message-edit";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

export function MessageEditDivider({ context, onPreview }: { context: MessageEditContext; onPreview?: (recoveryId: string, action: "Undo" | "Redo") => void }) {
  const text = messageEditText(context);
  const recoveryId = context.recoveryId;
  return (
    <TranscriptDivider data-message-edit-divider icon={PencilEdit02Icon} label={text}>
      <span className="shrink-0">{text}</span>
      {onPreview && recoveryId && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            data-message-edit-redo
            onClick={() => onPreview(recoveryId, "Redo")}
            className="relative shrink-0 font-semibold text-accent-ink before:absolute before:-inset-1 hover:underline"
          >
            Redo
          </button>
        </>
      )}
    </TranscriptDivider>
  );
}

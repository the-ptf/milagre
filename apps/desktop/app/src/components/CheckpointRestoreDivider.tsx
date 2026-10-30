import { Redo02Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import type { CheckpointRestoreContext } from "@milagre/shared/model";
import { checkpointRestoreAction, checkpointRestoreText } from "@milagre/shared/checkpoint-restore";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

/** Where Undo changes wrote files: a hairline with "Undid 2 files · Redo" centred on it, drawn as the reload line is. */
export function CheckpointRestoreDivider({
  context,
  onPreview,
}: {
  context: CheckpointRestoreContext;
  /** Previews the recovery checkpoint saved before those writes; nothing is written until that preview is confirmed. */
  onPreview?: (recoveryId: string, action: "Undo" | "Redo") => void;
}) {
  const text = checkpointRestoreText(context);
  const action = checkpointRestoreAction(context) as "Undo" | "Redo";
  return (
    <TranscriptDivider data-checkpoint-restore-divider icon={context.redo ? Redo02Icon : Undo02Icon} label={text}>
      <span className="shrink-0">{text}</span>
      {onPreview && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            data-checkpoint-redo
            onClick={() => onPreview(context.recoveryId, action)}
            className="relative shrink-0 font-semibold text-accent-ink before:absolute before:-inset-1 hover:underline"
          >
            {action}
          </button>
        </>
      )}
    </TranscriptDivider>
  );
}

import { HugeiconsIcon } from "@hugeicons/react";
import { Redo02Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import type { CheckpointRestoreContext } from "@milagre/shared/model";
import { checkpointRestoreAction, checkpointRestoreText } from "@milagre/shared/checkpoint-restore";

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
    <div data-checkpoint-restore-divider className="flex w-full items-center gap-3 py-1 text-[12px] text-ink-3" role="group" aria-label={text}>
      <span className="h-px flex-1 bg-line" />
      <span className="flex min-w-0 items-center gap-1.5 px-2 py-0.5">
        <HugeiconsIcon icon={context.redo ? Redo02Icon : Undo02Icon} size={13} strokeWidth={1.8} color="currentColor" className="shrink-0" />
        <span className="shrink-0">{text}</span>
        {onPreview && (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              data-checkpoint-redo
              onClick={() => onPreview(context.recoveryId, action)}
              className="shrink-0 font-semibold text-accent-ink hover:underline"
            >
              {action}
            </button>
          </>
        )}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

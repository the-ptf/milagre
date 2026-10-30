import { Redo02Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import type { CheckpointRestoreContext } from "@milagre/shared/model";
import { checkpointRestoreAction, checkpointRestoreText } from "@milagre/shared/checkpoint-restore";
import { PillButton } from "./primitives/pill-button";
import { TranscriptDivider } from "./primitives/transcript-divider";

/** Where Undo changes wrote files, as on desktop: "Undid 2 files" with a Redo button that opens its preview. The phone
 * keeps the action a small pill (desktop's inline link) for its touch target. */
export function CheckpointRestoreDivider({
  context,
  onPreview,
}: {
  context: CheckpointRestoreContext;
  onPreview?: (recoveryId: string, action: "Undo" | "Redo") => void;
}) {
  const text = checkpointRestoreText(context);
  const action = checkpointRestoreAction(context) as "Undo" | "Redo";
  return (
    <TranscriptDivider
      label={text}
      icon={context.redo ? Redo02Icon : Undo02Icon}
      trailing={
        onPreview && (
          <PillButton
            size="small"
            variant="secondary"
            title={action}
            accessibilityLabel={`${action}: preview the files first`}
            onPress={() => onPreview(context.recoveryId, action)}
          />
        )
      }
    />
  );
}

import { Pressable, Text } from "react-native";
import { Redo02Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import type { CheckpointRestoreContext } from "@milagre/shared/model";
import { checkpointRestoreAction, checkpointRestoreText } from "@milagre/shared/checkpoint-restore";
import { radius, type } from "./design-tokens";
import { pressStyle } from "./primitives/press-style";
import { TranscriptDivider } from "./primitives/transcript-divider";
import { useTheme } from "./theme";

/** Where Undo changes wrote files, as on desktop: "Undid 2 files" with a Redo button that opens its preview. */
export function CheckpointRestoreDivider({
  context,
  onPreview,
}: {
  context: CheckpointRestoreContext;
  onPreview?: (recoveryId: string, action: "Undo" | "Redo") => void;
}) {
  const { colors } = useTheme();
  const text = checkpointRestoreText(context);
  const action = checkpointRestoreAction(context) as "Undo" | "Redo";
  return (
    <TranscriptDivider
      label={text}
      icon={context.redo ? Redo02Icon : Undo02Icon}
      trailing={
        onPreview && (
          // ponytail: PillButton small (secondary) by hand, because the button's spoken label differs from its title.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${action}: preview the files first`}
            hitSlop={6}
            onPress={() => onPreview(context.recoveryId, action)}
            style={({ pressed }) => [
              {
                paddingHorizontal: 12,
                minHeight: 32,
                borderRadius: radius.full,
                borderCurve: "continuous",
                justifyContent: "center",
                borderWidth: 1,
                borderColor: colors.lineStrong,
                backgroundColor: colors.surface,
              },
              pressStyle({ pressed }),
            ]}
          >
            <Text style={{ color: colors.ink, fontSize: type.footnote, fontWeight: "600" }}>{action}</Text>
          </Pressable>
        )
      }
    />
  );
}

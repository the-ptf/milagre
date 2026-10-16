import { Pressable, Text, View } from "react-native";
import { Redo02Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import type { CheckpointRestoreContext } from "@milagre/shared/model";
import { checkpointRestoreAction, checkpointRestoreText } from "@milagre/shared/checkpoint-restore";
import { Icon } from "./icons";
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
    <View accessibilityLabel={text} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 }}>
        <Icon icon={context.redo ? Redo02Icon : Undo02Icon} tone="ink3" size={13} />
        <Text style={{ color: colors.ink3, fontSize: 13 }}>{text}</Text>
      </View>
      {onPreview && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${action}: preview the files first`}
          hitSlop={8}
          onPress={() => onPreview(context.recoveryId, action)}
          style={({ pressed }) => ({
            paddingHorizontal: 14,
            height: 30,
            borderRadius: 15,
            borderCurve: "continuous",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: colors.lineStrong,
            backgroundColor: colors.surface,
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <Text style={{ color: colors.ink, fontSize: 13, fontWeight: "600" }}>{action}</Text>
        </Pressable>
      )}
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}

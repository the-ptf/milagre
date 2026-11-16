import { Pressable, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { AlertCircleIcon, MicOff01Icon, PauseCircleIcon } from "@hugeicons/core-free-icons";
import { withAlpha } from "@milagre/shared/themes";
import type { DictationError, DictationErrorKind } from "@milagre/shared/voice-dictation";
import { duration, lineHeight, radius, type } from "./design-tokens";
import { Icon } from "./icons";
import { useAnnounce } from "./primitives/announce";
import { useTheme } from "./theme";

const ICONS: Record<DictationErrorKind, typeof MicOff01Icon> = {
  permission: MicOff01Icon,
  "no-speech": MicOff01Icon,
  failed: AlertCircleIcon,
  interrupted: PauseCircleIcon,
};
const MAX_WIDTH = 300;
const ARROW = 6;

export function DictationNotice({
  error,
  micSize,
  onDismiss,
  onOpenSettings,
}: {
  error: DictationError;
  micSize: number;
  onDismiss: () => void;
  onOpenSettings: () => void;
}) {
  const { colors, motionScale } = useTheme();
  const permission = error.kind === "permission";
  const ms = Math.round(duration.fast * motionScale);
  useAnnounce(error.message, { onMount: true });
  return (
    <Animated.View
      entering={motionScale > 0 ? FadeIn.duration(ms).reduceMotion(ReduceMotion.System) : undefined}
      exiting={motionScale > 0 ? FadeOut.duration(ms).reduceMotion(ReduceMotion.System) : undefined}
      pointerEvents="box-none"
      style={{ position: "absolute", right: 0, bottom: micSize + ARROW + 2, width: MAX_WIDTH, alignItems: "flex-end" }}
    >
      <Pressable
        accessible={!permission}
        accessibilityRole="alert"
        accessibilityLabel={error.message}
        accessibilityHint={permission ? undefined : "Dismisses the message"}
        disabled={permission}
        onPress={onDismiss}
        style={{ maxWidth: MAX_WIDTH, padding: 12, borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.ink, gap: 12 }}
      >
        <View
          accessible={permission}
          accessibilityRole={permission ? "alert" : undefined}
          accessibilityLabel={permission ? error.message : undefined}
          style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}
        >
          <View style={{ height: 20, justifyContent: "center" }}>
            <Icon icon={ICONS[error.kind]} color={colors.onInk} size={16} />
          </View>
          <Text style={{ flexShrink: 1, color: colors.onInk, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500" }}>
            {error.message}
          </Text>
        </View>
        {permission ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open Settings"
            hitSlop={6}
            onPress={onOpenSettings}
            style={({ pressed }) => ({
              minHeight: 32,
              borderRadius: radius.control,
              borderCurve: "continuous",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: withAlpha(colors.onInk, pressed ? 0.24 : 0.16),
            })}
          >
            <Text style={{ color: colors.onInk, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>Open Settings</Text>
          </Pressable>
        ) : null}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            bottom: -ARROW,
            right: micSize / 2 - ARROW,
            width: 0,
            height: 0,
            borderLeftWidth: ARROW,
            borderRightWidth: ARROW,
            borderTopWidth: ARROW,
            borderLeftColor: "transparent",
            borderRightColor: "transparent",
            borderTopColor: colors.ink,
          }}
        />
      </Pressable>
    </Animated.View>
  );
}

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

/**
 * A take's message in a bubble over the mic, its arrow on the mic, so the words sit by the button that tries again.
 * Rendered inside the mic's own box (`micSize` wide) and anchored to its right edge. Tapping it dismisses it; a refused
 * microphone adds a button to the app's Settings instead.
 */
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
  // The notice mounts with its message, so it is read as it shows.
  useAnnounce(error.message, { onMount: true });
  return (
    <Animated.View
      entering={motionScale > 0 ? FadeIn.duration(ms).reduceMotion(ReduceMotion.System) : undefined}
      exiting={motionScale > 0 ? FadeOut.duration(ms).reduceMotion(ReduceMotion.System) : undefined}
      pointerEvents="box-none"
      style={{ position: "absolute", right: 0, bottom: micSize + ARROW + 2, width: MAX_WIDTH, alignItems: "flex-end" }}
    >
      {/* With the Settings button the bubble isn't one element, so the button stays reachable on its own. */}
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
        {/* Centred on the mic under the bubble's right edge. */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            // A percentage top doesn't resolve here and drew the arrow inside the bubble, over the text.
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

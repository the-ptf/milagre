import { ActivityIndicator, Pressable } from "react-native";
import Animated, { ReduceMotion, useAnimatedStyle, withTiming, type SharedValue } from "react-native-reanimated";
import { Mic01Icon, StopIcon } from "@hugeicons/core-free-icons";
import { withAlpha } from "@milagre/shared/themes";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import type { DictationPhase } from "@milagre/shared/voice-dictation";

export const MIC_SIZE = 32;
const SIZE = MIC_SIZE;
const LABELS: Record<DictationPhase, string> = {
  idle: "Dictate",
  preparing: "Starting dictation",
  recording: "Stop dictation",
  transcribing: "Transcribing",
};

/** The mic at the trailing edge of the composer: tap to record, tap again to stop. While recording a halo swells with the voice. */
export function VoiceMicButton({ phase, level, onPress }: { phase: DictationPhase; level: SharedValue<number>; onPress: () => void }) {
  const { colors, motionScale } = useTheme();
  const recording = phase === "recording";
  const busy = phase === "preparing" || phase === "transcribing";
  const halo = useAnimatedStyle(() => {
    // With motion off the halo holds still at a middling size: recording still reads, nothing moves.
    if (motionScale <= 0) return { transform: [{ scale: 1.25 }] };
    return {
      transform: [{ scale: withTiming(1 + level.value * 0.7, { duration: Math.round(80 * motionScale), reduceMotion: ReduceMotion.System }) }],
    };
  });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={LABELS[phase]}
      accessibilityState={{ busy }}
      disabled={busy}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({ width: SIZE, height: SIZE, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
    >
      {recording ? (
        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: withAlpha(colors.red, 0.28) }, halo]}
        />
      ) : null}
      <Animated.View
        style={{
          width: SIZE - 6,
          height: SIZE - 6,
          borderRadius: (SIZE - 6) / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: recording ? colors.red : "transparent",
        }}
      >
        {phase === "transcribing" ? (
          <ActivityIndicator size="small" color={colors.ink2} />
        ) : (
          <Icon
            icon={recording ? StopIcon : Mic01Icon}
            size={recording ? 14 : 20}
            color={recording ? "#fff" : undefined}
            tone={phase === "preparing" ? "ink3" : "ink2"}
          />
        )}
      </Animated.View>
    </Pressable>
  );
}

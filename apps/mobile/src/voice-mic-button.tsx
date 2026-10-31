import { useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Cancel01Icon, Mic01Icon } from "@hugeicons/core-free-icons";
import { withAlpha } from "@milagre/shared/themes";
import { radius } from "./design-tokens";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import type { DictationPhase } from "@milagre/shared/voice-dictation";

export const MIC_SIZE = 44;
const SIZE = 32;
/** The capsule's two controls: smaller than 44pt on purpose, with `hitSlop` making up the target. */
const CONTROL = 28;
/** How wide the trailing control gets once the mic grows into the capsule. */
export const CAPSULE_WIDTH = 6 + CONTROL + 4 + CONTROL + 6;

/** The mic at the trailing edge of the composer: tap to record. While a take runs the capsule stands in its place. */
export function VoiceMicButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Dictate"
      onPress={onPress}
      style={({ pressed }) => ({ width: MIC_SIZE, height: MIC_SIZE, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
    >
      <View style={{ width: SIZE - 6, height: SIZE - 6, alignItems: "center", justifyContent: "center" }}>
        <Icon icon={Mic01Icon} size={20} tone="ink2" />
      </View>
    </Pressable>
  );
}

/**
 * The take's own control, in the mic's place: discard it, or stop it. Nothing else in the composer changes, so the words
 * in the field stay where they are. The stop is a red square, never the agent's dark Stop circle.
 */
export function DictationCapsule({
  phase,
  level,
  onDiscard,
  onStop,
}: {
  phase: DictationPhase;
  level: SharedValue<number>;
  onDiscard: () => void;
  onStop: () => void;
}) {
  const { colors, motionScale } = useTheme();
  const recording = phase === "recording";
  const halo = useAnimatedStyle(() => {
    // With motion off the halo holds still at a middling size: recording still reads, nothing moves.
    if (motionScale <= 0) return { transform: [{ scale: 1.25 }] };
    return {
      transform: [{ scale: withTiming(1 + level.value * 0.7, { duration: Math.round(80 * motionScale), reduceMotion: ReduceMotion.System }) }],
    };
  });
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        height: MIC_SIZE,
        paddingHorizontal: 6,
        borderRadius: 999,
        borderCurve: "continuous",
        backgroundColor: colors.hover,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Discard dictation"
        accessibilityHint="Takes the dictated words back out and leaves the rest of the message"
        hitSlop={8}
        onPress={onDiscard}
        style={({ pressed }) => ({ width: CONTROL, height: CONTROL, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
      >
        <Icon icon={Cancel01Icon} size={18} tone="ink2" />
      </Pressable>
      {recording ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop dictation"
          hitSlop={8}
          onPress={onStop}
          style={({ pressed }) => ({ width: CONTROL, height: CONTROL, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
        >
          <Animated.View
            pointerEvents="none"
            style={[{ position: "absolute", width: CONTROL, height: CONTROL, borderRadius: CONTROL / 2, backgroundColor: withAlpha(colors.red, 0.28) }, halo]}
          />
          <View style={{ width: 16, height: 16, borderRadius: radius.chip, borderCurve: "continuous", backgroundColor: colors.red }} />
        </Pressable>
      ) : (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={phase === "preparing" ? "Preparing the microphone" : "Finishing the last words"}
          style={{ width: CONTROL, height: CONTROL, alignItems: "center", justifyContent: "center" }}
        >
          <MicLoadingRing />
        </View>
      )}
    </View>
  );
}

/** An arc turning while dictation starts or the take is finished; with motion off it holds still. */
function MicLoadingRing() {
  const { colors, motionScale } = useTheme();
  const turn = useSharedValue(0);
  useEffect(() => {
    if (motionScale <= 0) return;
    turn.set(withRepeat(withTiming(1, { duration: 900, easing: Easing.linear, reduceMotion: ReduceMotion.System }), -1, false));
    return () => cancelAnimation(turn);
  }, [motionScale, turn]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 360}deg` }] }));
  const RING = 20;
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={{ position: "absolute", width: RING, height: RING, borderRadius: RING / 2, borderWidth: 2, borderColor: withAlpha(colors.ink3, 0.25) }}
      />
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            width: RING,
            height: RING,
            borderRadius: RING / 2,
            borderWidth: 2,
            borderColor: "transparent",
            borderTopColor: colors.ink2,
            borderRightColor: colors.ink2,
          },
          spin,
        ]}
      />
    </>
  );
}

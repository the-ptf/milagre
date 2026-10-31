import { useEffect, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
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
/**
 * The capsule is shorter than the mic's 44pt box and sits inset from the field's edges: a one-line field is only 44
 * tall, so a 44 capsule anchored to its bottom padding would hang over the top of the composer's own background.
 */
const CAPSULE_HEIGHT = 36;
/**
 * The composer's send button is 34pt and flush with the card's content edge (app/chat.tsx), as the field above it is: the
 * mic, and the capsule's stop button after it, stand over its centre. Both reach a few points into the card's padding.
 */
const SEND_CENTER = 34 / 2;
export const MIC_INSET = { right: SEND_CENTER - MIC_SIZE / 2, bottom: 6 };
export const CAPSULE_INSET = { right: SEND_CENTER - 6 - CONTROL / 2, bottom: 4 };
// The level halo swells inside the capsule and no further: 22 at rest, 35.2 at full voice, under CAPSULE_HEIGHT.
const HALO = 22;
const HALO_SWELL = 0.6;

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

/** The ring a model download fills, from the top, clockwise: 0..1. */
export function DownloadRing({ size, stroke, progress, children }: { size: number; stroke: number; progress: number; children?: ReactNode }) {
  const { colors } = useTheme();
  const arc = (size - stroke) / 2;
  const circumference = 2 * Math.PI * arc;
  const filled = Math.max(0, Math.min(1, progress));
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}>
        <Circle cx={size / 2} cy={size / 2} r={arc} fill="none" stroke={colors.lineStrong} strokeWidth={stroke} />
        {filled > 0 ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={arc}
            fill="none"
            stroke={colors.ink}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={circumference * (1 - filled)}
          />
        ) : null}
      </Svg>
      {children}
    </View>
  );
}

const ARROW = 18;
const WELL = 22;

/** The arrow that keeps dropping through the ring: it falls in, rests, and drops out below. With motion off it holds still. */
function DroppingArrow() {
  const { colors, motionScale } = useTheme();
  const drop = useSharedValue(0);
  useEffect(() => {
    if (motionScale <= 0) return;
    const ease = ReduceMotion.System;
    drop.set(
      withRepeat(
        withSequence(
          withTiming(-1, { duration: 0, reduceMotion: ease }),
          withTiming(0, { duration: 455, easing: Easing.bezier(0.2, 0.8, 0.3, 1), reduceMotion: ease }),
          withTiming(0, { duration: 350, reduceMotion: ease }),
          withTiming(1, { duration: 495, easing: Easing.bezier(0.6, 0, 0.9, 0.4), reduceMotion: ease }),
        ),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(drop);
  }, [drop, motionScale]);
  const style = useAnimatedStyle(() => ({
    opacity: 1 - Math.abs(drop.get()),
    transform: [{ translateY: drop.get() * WELL * 0.9 }],
  }));
  return (
    <View style={{ width: WELL, height: WELL, borderRadius: WELL / 2, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
      <Animated.View style={style}>
        <Svg width={ARROW} height={ARROW} viewBox="0 0 24 24" fill="none">
          <Path d="M12 4v15M6 13l6 6 6-6" stroke={colors.ink} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </Animated.View>
    </View>
  );
}

/** The mic while the take's speech model downloads: tap to cancel. The take records once it lands. */
function DictationDownload({ progress, onCancel }: { progress: number; onCancel: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Downloading speech model, ${Math.round(progress * 100)} percent`}
      accessibilityHint="Cancels the download"
      onPress={onCancel}
      style={({ pressed }) => ({ width: MIC_SIZE, height: MIC_SIZE, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
    >
      <DownloadRing size={30} stroke={2.5} progress={progress}>
        <DroppingArrow />
      </DownloadRing>
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
  download,
  onDiscard,
  onStop,
}: {
  phase: DictationPhase;
  level: SharedValue<number>;
  /** How far the take's model download is, 0..1, while it downloads; the mic shows the ring then, not the capsule. */
  download: number | null;
  onDiscard: () => void;
  onStop: () => void;
}) {
  if (phase === "downloading") return <DictationDownload progress={download ?? 0} onCancel={onDiscard} />;
  return <Capsule phase={phase} level={level} onDiscard={onDiscard} onStop={onStop} />;
}

function Capsule({ phase, level, onDiscard, onStop }: { phase: DictationPhase; level: SharedValue<number>; onDiscard: () => void; onStop: () => void }) {
  const { colors, motionScale } = useTheme();
  const recording = phase === "recording";
  const halo = useAnimatedStyle(() => {
    // With motion off the halo holds still at a middling size: recording still reads, nothing moves.
    if (motionScale <= 0) return { transform: [{ scale: 1.25 }] };
    return {
      transform: [{ scale: withTiming(1 + level.value * HALO_SWELL, { duration: Math.round(80 * motionScale), reduceMotion: ReduceMotion.System }) }],
    };
  });
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        height: CAPSULE_HEIGHT,
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
            style={[{ position: "absolute", width: HALO, height: HALO, borderRadius: HALO / 2, backgroundColor: withAlpha(colors.red, 0.28) }, halo]}
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

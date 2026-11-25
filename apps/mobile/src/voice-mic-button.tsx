import { duration, radius } from "./design-tokens";
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
import { pressStyle } from "./primitives/press-style";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { useReducedMotion } from "./motion";
import type { DictationPhase } from "@milagre/shared/voice-dictation";

export const MIC_SIZE = 44;
const CONTROL = 28;
const CAPSULE_HEIGHT = 36;
const HALO = 22;
const HALO_SWELL = 0.6;

export function VoiceMicButton({ onPress, onLongPress, processing = null }: { onPress: () => void; onLongPress?: () => void; processing?: string | null }) {
  const correcting = processing !== null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Dictate"
      accessibilityValue={correcting ? { text: processing ? `Correcting names · ${processing}` : "Correcting names" } : undefined}
      accessibilityHint={
        correcting ? "Starts a new dictation and drops the pending correction" : onLongPress ? "Touch and hold for dictation options" : undefined
      }
      accessibilityLiveRegion="polite"
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => ({ width: MIC_SIZE, height: MIC_SIZE, alignItems: "center", justifyContent: "center", ...pressStyle({ pressed }) })}
    >
      <Icon icon={Mic01Icon} size={20} tone="ink2" />
    </Pressable>
  );
}

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
          withTiming(0, { duration: duration.slow, easing: Easing.bezier(0.2, 0.8, 0.3, 1), reduceMotion: ease }),
          withTiming(0, { duration: duration.slow, reduceMotion: ease }),
          withTiming(1, { duration: duration.slow, easing: Easing.bezier(0.6, 0, 0.9, 0.4), reduceMotion: ease }),
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

function DictationDownload({ progress, onCancel }: { progress: number; onCancel: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Downloading speech model, ${Math.round(progress * 100)} percent`}
      accessibilityHint="Cancels the download"
      onPress={onCancel}
      style={({ pressed }) => ({ width: MIC_SIZE, height: MIC_SIZE, alignItems: "center", justifyContent: "center", ...pressStyle({ pressed }) })}
    >
      <DownloadRing size={30} stroke={2.5} progress={progress}>
        <DroppingArrow />
      </DownloadRing>
    </Pressable>
  );
}

export function DictationCapsule({
  phase,
  level,
  download,
  onDiscard,
  onStop,
}: {
  phase: DictationPhase;
  level: SharedValue<number>;
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
        borderRadius: radius.full,
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
        style={({ pressed }) => ({ width: CONTROL, height: CONTROL, alignItems: "center", justifyContent: "center", ...pressStyle({ pressed }) })}
      >
        <Icon icon={Cancel01Icon} size={18} tone="ink2" />
      </Pressable>
      {recording ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop dictation"
          hitSlop={8}
          onPress={onStop}
          style={({ pressed }) => ({ width: CONTROL, height: CONTROL, alignItems: "center", justifyContent: "center", ...pressStyle({ pressed }) })}
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
          accessibilityLiveRegion="polite"
          accessibilityLabel={phase === "preparing" ? "Preparing the microphone" : "Finishing the last words"}
          style={{ width: CONTROL, height: CONTROL, alignItems: "center", justifyContent: "center" }}
        >
          <MicLoadingRing />
        </View>
      )}
    </View>
  );
}

function MicLoadingRing() {
  const { colors, motionScale } = useTheme();
  const reducedMotion = useReducedMotion();
  const turn = useSharedValue(0);
  const opacity = useSharedValue(1);
  useEffect(() => {
    turn.set(0);
    opacity.set(1);
    if (reducedMotion) {
      const timing = { duration: 800, easing: Easing.steps(2), reduceMotion: ReduceMotion.Never };
      opacity.set(withRepeat(withSequence(withTiming(0.45, timing), withTiming(1, timing)), -1, false, undefined, ReduceMotion.Never));
    } else {
      turn.set(withRepeat(withTiming(1, { duration: Math.round(900 * motionScale), easing: Easing.linear, reduceMotion: ReduceMotion.System }), -1, false));
    }
    return () => {
      cancelAnimation(turn);
      cancelAnimation(opacity);
    };
  }, [motionScale, opacity, reducedMotion, turn]);
  const spin = useAnimatedStyle(() => ({ opacity: opacity.get(), transform: [{ rotate: `${turn.get() * 360}deg` }] }));
  const RING = 20;
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          width: RING,
          height: RING,
          borderRadius: RING / 2,
          borderWidth: 2,
          borderColor: withAlpha(colors.ink3, 0.25),
        }}
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

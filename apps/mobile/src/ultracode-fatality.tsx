import { useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as Font from "expo-font";
import { mix, withAlpha } from "@milagre/shared/themes";
import { useTheme } from "./theme";
import { useUltracodeAudio } from "./ultracode-audio";

const DURATION = 2600;
// Sparks that burst out of the word in jittery hops and flicker as they fade: a fixed scatter so every run looks the same.
const DOTS = Array.from({ length: 70 }, (_, index) => {
  const angle = index * 2.399963;
  const reach = 70 + ((index * 53) % 150);
  return {
    x: Math.cos(angle) * reach * 1.4,
    y: Math.sin(angle) * reach,
    wobble: (((index * 7) % 21) - 10) * 1.4,
    size: 4 + (index % 4) * 1.5,
    delay: 120 + ((index * 37) % 120) * 10,
    duration: 550 + ((index * 17) % 45) * 10,
  };
});
const FALLBACK = Platform.select({ ios: "Futura-CondensedExtraBold", default: "sans-serif-condensed" });
// Creepster (Font Diner, SIL OFL 1.1, see assets/fonts/Creepster-OFL.txt), loaded at runtime so it ships over the air.
const CREEPSTER = { Creepster: require("../assets/fonts/Creepster-Regular.ttf") };

/** Turning Ultracode on, Mortal Kombat style in Milagre purple: the sheet darkens and shakes, ULTRACODE slams in, dots float out of it, and the
 * announcer and the model sheet's Ultra rumble play under it. Reduced motion keeps the word and voice, not the slam. */
export function UltracodeFatality({ onDone }: { onDone: () => void }) {
  useUltracodeAudio();
  const { colors } = useTheme();
  const reduce = useReducedMotion();
  const [font, setFont] = useState(Font.isLoaded("Creepster") ? "Creepster" : FALLBACK);
  useEffect(() => {
    if (font === "Creepster") return;
    Font.loadAsync(CREEPSTER)
      .then(() => setFont("Creepster"))
      .catch(() => {});
  }, [font]);
  const veil = useSharedValue(0);
  const scale = useSharedValue(reduce ? 1 : 3.2);
  const word = useSharedValue(0);
  const shake = useSharedValue(0);

  useEffect(() => {
    const timing = (value: number, duration: number) => withTiming(value, { duration, reduceMotion: ReduceMotion.Never });
    veil.value = withSequence(
      timing(1, 160),
      withDelay(
        DURATION - 640,
        withTiming(0, { duration: 480, reduceMotion: ReduceMotion.Never }, (finished) => {
          if (finished) scheduleOnRN(onDone);
        }),
      ),
    );
    word.value = withDelay(80, timing(1, 180));
    if (!reduce) {
      scale.value = withDelay(80, withSequence(withTiming(0.94, { duration: 240, easing: Easing.bezier(0.2, 0.9, 0.3, 1) }), withTiming(1, { duration: 90 })));
      shake.value = withDelay(260, withSequence(...[-14, 12, -9, 7, -4, 2, 0].map((offset) => withTiming(offset, { duration: 55 }))));
    }
    // Plays once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const veilStyle = useAnimatedStyle(() => ({ opacity: veil.value }));
  const wordStyle = useAnimatedStyle(() => ({
    opacity: word.value,
    transform: [{ translateX: shake.value }, { translateY: shake.value * -0.6 }, { scale: scale.value }],
  }));

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: 100, alignItems: "center", justifyContent: "center" }, veilStyle]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(colors.media, 0.8) }]} />
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            experimental_backgroundImage: `radial-gradient(ellipse at center, transparent 30%, ${withAlpha(mix(colors.purple, colors.media, 0.5), 0.6)} 100%)`,
          },
        ]}
      />
      <Animated.View style={wordStyle}>
        <Animated.Text
          accessibilityElementsHidden
          style={{
            fontFamily: font,
            fontSize: 56,
            letterSpacing: 2,
            color: mix(colors.purple, colors.onMedia, 0.3),
            textShadowColor: withAlpha(colors.purple, 0.8),
            textShadowRadius: 18,
          }}
        >
          ULTRACODE
        </Animated.Text>
        {!reduce && DOTS.map((dot, index) => <Dot key={index} {...dot} light={index % 3 === 0} />)}
      </Animated.View>
    </Animated.View>
  );
}

function Dot({
  x,
  y,
  wobble,
  size,
  delay,
  duration,
  light,
}: {
  x: number;
  y: number;
  wobble: number;
  size: number;
  delay: number;
  duration: number;
  light: boolean;
}) {
  const { colors } = useTheme();
  const spark = mix(colors.purple, colors.onMedia, 0.3);
  const t = useSharedValue(0);
  useEffect(() => {
    t.set(withDelay(delay, withTiming(1, { duration, easing: Easing.linear })));
  }, [delay, duration, t]);
  const style = useAnimatedStyle(() => {
    const p = t.get();
    // Four hops sideways and a flicker on the way out, so the spark jitters instead of gliding.
    const hop = Math.sin(p * Math.PI * 4) * wobble;
    const flicker = Math.abs(Math.sin(p * Math.PI * 3));
    return {
      opacity: p === 0 ? 0 : (1 - p) * (0.35 + 0.65 * flicker),
      transform: [{ translateX: x * p + hop }, { translateY: (y - 20) * p - hop }, { scale: 0.5 + flicker * 0.8 }],
    };
  });
  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          top: "50%",
          left: "50%",
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: light ? mix(colors.purple, colors.onMedia, 0.6) : spark,
          boxShadow: `0 0 10px 2px ${withAlpha(spark, 0.9)}`,
        },
        style,
      ]}
    />
  );
}

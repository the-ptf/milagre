import { useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Image, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Defs, G, Path, RadialGradient, Stop, Circle } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LEFT, RIGHT, STAR, STAR_BOX } from "./logo";
import { pressStyle } from "./primitives/press-style";
import { lineHeight, radius, type } from "./design-tokens";

// Desktop's OnboardingIntro ("Dawn", styles.css .onboarding-intro-*): the same scene and timings on the phone. Its night,
// dawn and day colours are the scene's own and stay the same in every theme.
const LOGO = 92;
const SERIF = Platform.select({ ios: "Georgia", default: "serif" });
const ease = Easing.bezier(0.22, 1, 0.36, 1);
const inOut = Easing.bezier(0.65, 0, 0.35, 1);
const fall = Easing.bezier(0.45, 0, 0.15, 1);
const cloudEase = Easing.bezier(0.16, 1, 0.3, 1);
// The scene's own beats in ms (desktop's keyframes), not UI motion, so they don't use the `duration` tokens.
const BEAT = { dim: 432, light: 288, swell: 480, turn: 360, leave: 900, raysTurn: 90000 } as const;

function seeded(seed: number) {
  return () => {
    seed = (Math.imul(seed ^ (seed >>> 15), seed | 1) + 0x6d2b79f5) | 0;
    return (seed >>> 0) / 4294967296;
  };
}

/** One value of the scene that runs 0 → 1 after `delay` over `duration`. */
function useStep(delay: number, duration: number, easing: (t: number) => number = ease) {
  const [step] = useState(() => ({ progress: new Animated.Value(0), delay, duration, easing }));
  return step;
}

type Step = ReturnType<typeof useStep>;

/** The running logo's beat (running-logo.tsx), from the lit mark: each leg dims after its turn and lights again. */
function runLoop(leg: Animated.Value, delay: number) {
  return Animated.sequence([
    Animated.delay(delay),
    Animated.loop(
      Animated.sequence([
        Animated.delay(192),
        Animated.timing(leg, { toValue: 1, duration: BEAT.dim, easing: inOut, useNativeDriver: true }),
        Animated.delay(1296),
        Animated.timing(leg, { toValue: 0, duration: BEAT.light, easing: inOut, useNativeDriver: true }),
        Animated.delay(192),
      ]),
    ),
  ]);
}

/**
 * The first-launch intro: a night sky, a falling star that lands where the logo's sparkle sits, the legs rising under it
 * with the loading mark's motion, dawn breaking into day around "Milagre", then the running logo's beat. Begin or Skip
 * fades it out and calls `onDone`. Reduced motion shows the last frame with Begin.
 */
export function OnboardingIntro({ onDone }: { onDone: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const dawn = useStep(500, 1500, Easing.inOut(Easing.ease));
  const day = useStep(1900, 1700, Easing.inOut(Easing.ease));
  const starsOut = useStep(1300, 1400, Easing.in(Easing.ease));
  const clouds = useStep(400, 2600, cloudEase);
  const comet = useStep(500, 1250, fall);
  const tailOut = useStep(1600, 500);
  const halo = useStep(1750, 1200);
  const legLeft = useStep(1750, 240);
  const legRight = useStep(1790, 240);
  const rays = useStep(2100, 1600, Easing.out(Easing.ease));
  const title = useStep(2550, 900);
  const lede = useStep(2850, 900);
  const begin = useStep(3400, 800);
  const skipTone = useStep(1900, 1600);
  const [leaving] = useState(() => new Animated.Value(0));
  const [runLeft] = useState(() => new Animated.Value(0));
  const [runRight] = useState(() => new Animated.Value(0));
  const [runStar] = useState(() => new Animated.Value(0));
  const [spin] = useState(() => new Animated.Value(0));
  const [left, setLeft] = useState(false);

  useEffect(() => {
    const all: Step[] = [dawn, day, starsOut, clouds, comet, tailOut, halo, legLeft, legRight, rays, title, lede, begin, skipTone];
    let scene: Animated.CompositeAnimation | undefined;
    let cancelled = false;
    void (async () => {
      const reduced = await AccessibilityInfo.isReduceMotionEnabled();
      if (cancelled) return;
      if (reduced) {
        for (const step of all) step.progress.setValue(1);
        return;
      }
      scene = Animated.parallel([
        ...all.map((step) =>
          Animated.timing(step.progress, { toValue: 1, delay: step.delay, duration: step.duration, easing: step.easing, useNativeDriver: true }),
        ),
        // After the landing the whole mark runs: legs in turn, the sparkle swells and turns a quarter.
        runLoop(runLeft, 3000),
        runLoop(runRight, 3240),
        Animated.sequence([
          Animated.delay(3000),
          Animated.loop(
            Animated.sequence([
              Animated.delay(720),
              Animated.timing(runStar, { toValue: 1, duration: BEAT.swell, easing: inOut, useNativeDriver: true }),
              Animated.timing(runStar, { toValue: 2, duration: BEAT.turn, easing: inOut, useNativeDriver: true }),
              Animated.timing(runStar, { toValue: 3, duration: BEAT.turn, easing: inOut, useNativeDriver: true }),
              Animated.delay(480),
              Animated.timing(runStar, { toValue: 0, duration: 0, useNativeDriver: true }),
            ]),
          ),
        ]),
        Animated.loop(Animated.timing(spin, { toValue: 1, duration: BEAT.raysTurn, easing: Easing.linear, useNativeDriver: true })),
      ]);
      scene.start();
    })();
    return () => {
      cancelled = true;
      scene?.stop();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one scene per mount; the values never change
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- one scene per mount

  const leave = () => {
    if (left) return;
    setLeft(true);
    Animated.timing(leaving, { toValue: 1, duration: BEAT.leave, easing: Easing.bezier(0.4, 0, 0.2, 1), useNativeDriver: true }).start(() => onDone());
  };

  const centerY = height * 0.42;
  const fade = (step: Step) => ({ opacity: step.progress });
  const rise = (step: Step) => ({
    opacity: step.progress,
    transform: [{ translateY: step.progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
  });
  const stars = useMemo(() => {
    const random = seeded(11);
    return Array.from({ length: 70 }, (_, id) => ({
      id,
      left: random() * 100,
      top: random() * 70,
      size: random() * 1.8 + 0.6,
      opacity: 0.35 + random() * 0.6,
    }));
  }, []);
  const starSize = (STAR_BOX.size / 154) * LOGO;
  const starTop = centerY - LOGO / 2 + ((STAR_BOX.y + 4) / 154) * LOGO;
  const tailAngle = -Math.atan2(0.62 * height, 0.34 * width);
  const haloSize = LOGO * 4.2;
  const raysSize = Math.max(width, height) * 1.6;
  const legStyle = (up: Step, run: Animated.Value) => ({
    opacity: Animated.multiply(up.progress, run.interpolate({ inputRange: [0, 1], outputRange: [1, 0.55] })),
    transform: [{ translateY: up.progress.interpolate({ inputRange: [0, 1], outputRange: [LOGO * 0.18, 0] }) }],
  });
  const runSteps = [0, 1, 2, 3];
  const layer = (path: string) => (
    <Svg width={LOGO} height={LOGO} viewBox="-4 -4 154 154">
      <Path d={path} fill="#fff" />
    </Svg>
  );

  return (
    <Animated.View
      accessibilityViewIsModal
      style={[
        StyleSheet.absoluteFill,
        {
          zIndex: 10,
          backgroundColor: "#070b1f",
          opacity: leaving.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          transform: [{ scale: leaving.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) }],
        },
      ]}
    >
      <LinearGradient colors={["#070b1f", "#141c45", "#252a5c"]} locations={[0, 0.55, 1]} style={StyleSheet.absoluteFill} />
      <Animated.View style={[StyleSheet.absoluteFill, fade(dawn)]}>
        <LinearGradient colors={["#262c66", "#7b62a3", "#e29a9a", "#f8cf98"]} locations={[0, 0.36, 0.64, 1]} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, fade(day)]}>
        <LinearGradient colors={["#c3dbf3", "#e9f0f8", "#fff2dd", "#fffaf0"]} locations={[0, 0.36, 0.72, 1]} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { opacity: starsOut.progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}
      >
        {stars.map((star) => (
          <View
            key={star.id}
            style={{
              position: "absolute",
              left: `${star.left}%`,
              top: `${star.top}%`,
              width: star.size,
              height: star.size,
              borderRadius: star.size,
              backgroundColor: "#fff",
              opacity: star.opacity,
            }}
          />
        ))}
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: width / 2 - raysSize / 2,
          top: centerY - raysSize / 2,
          width: raysSize,
          height: raysSize,
          opacity: rays.progress,
          transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }],
        }}
      >
        <Svg width={raysSize} height={raysSize} viewBox="-100 -100 200 200">
          <Defs>
            <RadialGradient id="ray" cx="0" cy="0" r="100" gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor="#ffecbe" stopOpacity={0.34} />
              <Stop offset="0.18" stopColor="#ffecbe" stopOpacity={0.2} />
              <Stop offset="0.52" stopColor="#ffecbe" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <G fill="url(#ray)">
            {Array.from({ length: 21 }, (_, index) => {
              const a = (index * 360) / 21;
              const wedge = (angle: number) => `${Math.cos((angle * Math.PI) / 180) * 100} ${Math.sin((angle * Math.PI) / 180) * 100}`;
              return <Path key={a} d={`M0 0L${wedge(a)}L${wedge(a + 5)}Z`} />;
            })}
          </G>
        </Svg>
      </Animated.View>
      {(["back", "front"] as const).map((bank) => (
        <Animated.View
          key={bank}
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 380,
            transform: [{ translateY: clouds.progress.interpolate({ inputRange: [0, 1], outputRange: [height * 0.38, 0] }) }],
          }}
        >
          <Image
            source={bank === "back" ? require("../assets/onboarding-clouds-back.png") : require("../assets/onboarding-clouds-front.png")}
            resizeMode="stretch"
            style={{ width: "100%", height: "100%" }}
          />
        </Animated.View>
      ))}
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: width / 2 - haloSize / 2,
          top: centerY - haloSize / 2,
          width: haloSize,
          height: haloSize,
          opacity: halo.progress,
          transform: [{ scale: halo.progress.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
        }}
      >
        <Svg width={haloSize} height={haloSize}>
          <Defs>
            <RadialGradient id="halo" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="#fff4d4" stopOpacity={0.95} />
              <Stop offset="0.22" stopColor="#ffe2a0" stopOpacity={0.55} />
              <Stop offset="0.45" stopColor="#ffd68c" stopOpacity={0.18} />
              <Stop offset="0.68" stopColor="#ffd68c" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={haloSize / 2} cy={haloSize / 2} r={haloSize / 2} fill="url(#halo)" />
        </Svg>
      </Animated.View>
      <View pointerEvents="none" style={{ position: "absolute", left: width / 2 - LOGO / 2, top: centerY - LOGO / 2, width: LOGO, height: LOGO }}>
        <Animated.View style={[StyleSheet.absoluteFill, legStyle(legLeft, runLeft)]}>{layer(LEFT)}</Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, legStyle(legRight, runRight)]}>{layer(RIGHT)}</Animated.View>
      </View>
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: width / 2 - starSize / 2,
          top: starTop,
          width: starSize,
          height: starSize,
          opacity: comet.progress.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 1, 1] }),
          transform: [
            { translateX: comet.progress.interpolate({ inputRange: [0, 1], outputRange: [width * 0.34, 0] }) },
            { translateY: comet.progress.interpolate({ inputRange: [0, 1], outputRange: [-height * 0.62, 0] }) },
            { scale: comet.progress.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) },
          ],
        }}
      >
        <Animated.View
          style={{
            position: "absolute",
            left: starSize / 2,
            top: starSize / 2 - 1.5,
            width: height * 0.55,
            height: 3,
            borderRadius: radius.full,
            overflow: "hidden",
            opacity: tailOut.progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
            transformOrigin: "left center",
            transform: [{ rotate: `${tailAngle}rad` }],
          }}
        >
          <LinearGradient
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            colors={["rgba(255,244,214,0.95)", "rgba(255,214,150,0.35)", "rgba(255,214,150,0)"]}
            locations={[0, 0.4, 1]}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <Animated.View
          style={{
            width: starSize,
            height: starSize,
            transform: [
              { scale: runStar.interpolate({ inputRange: runSteps, outputRange: [1, 1.3, 1.12, 1] }) },
              { rotate: runStar.interpolate({ inputRange: runSteps, outputRange: ["0deg", "45deg", "80deg", "90deg"] }) },
            ],
          }}
        >
          <Svg width="100%" height="100%" viewBox={`${STAR_BOX.x} ${STAR_BOX.y} ${STAR_BOX.size} ${STAR_BOX.size}`}>
            <Path d={STAR} fill="#fff" />
          </Svg>
        </Animated.View>
      </Animated.View>
      <View style={{ position: "absolute", left: 24, right: 24, top: centerY + LOGO * 0.78, alignItems: "center" }}>
        <Animated.Text
          accessibilityRole="header"
          style={[{ fontFamily: SERIF, fontSize: type.largeTitle, lineHeight: lineHeight.largeTitle, color: "#33291a" }, rise(title)]}
        >
          Milagre
        </Animated.Text>
        <Animated.Text
          style={[{ marginTop: 6, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, color: "#7d6c53", textAlign: "center" }, rise(lede)]}
        >
          Portuguese for <Text style={{ fontFamily: SERIF, fontStyle: "italic", color: "#5c4a2f" }}>miracle</Text>. Let’s make one.
        </Animated.Text>
      </View>
      <Animated.View style={[{ position: "absolute", left: 24, right: 24, bottom: Math.max(insets.bottom, 16) + 24 }, rise(begin)]}>
        <Pressable
          accessibilityRole="button"
          onPress={leave}
          style={({ pressed }) => [
            {
              height: 54,
              borderRadius: radius.full,
              backgroundColor: "#2a2116",
              alignItems: "center",
              justifyContent: "center",
              shadowColor: "#c49234",
              shadowOpacity: 0.38,
              shadowRadius: 17,
              shadowOffset: { width: 0, height: 10 },
            },
            pressStyle({ pressed }),
          ]}
        >
          <Text style={{ color: "#fffaf0", fontSize: type.body, fontWeight: "600" }}>Begin</Text>
        </Pressable>
      </Animated.View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Skip"
        onPress={leave}
        hitSlop={12}
        style={{ position: "absolute", top: insets.top + 8, right: 20, padding: 6 }}
      >
        <View>
          <Animated.Text
            style={{
              fontSize: type.subheadline,
              fontWeight: "500",
              color: "rgba(255,255,255,0.6)",
              opacity: skipTone.progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
            }}
          >
            Skip
          </Animated.Text>
          <Animated.Text
            style={{ position: "absolute", fontSize: type.subheadline, fontWeight: "500", color: "rgba(60,48,30,0.6)", opacity: skipTone.progress }}
          >
            Skip
          </Animated.Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

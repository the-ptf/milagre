import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import { useTheme } from "./theme";
import { LoadingLogo } from "./loading-logo";

// The native launch screen shows the assembled mark at this size and spot, so the hand-off is seamless.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/**
 * Desktop's StartupSplash. The native launch screen already shows the assembled mark, so this takes over from it in
 * place: the sparkle twinkles until the app is ready, then the splash fades while the logo shrinks slightly.
 * Timings and curves match styles.css.
 */
export function StartupSplash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const { colors } = useTheme();
  const page = colors.page;
  const [[fade, shrink]] = useState<[Animated.Value, Animated.Value]>(() => [new Animated.Value(0), new Animated.Value(0)]);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);
  useEffect(() => {
    if (!ready) return;
    // splash-leave and splash-logo-leave run together with their own curves; runs once, so session updates cannot restart it.
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 320, easing: Easing.bezier(0.4, 0, 0.2, 1), useNativeDriver: true }),
      Animated.timing(shrink, { toValue: 1, duration: 320, easing: Easing.bezier(0.4, 0, 1, 1), useNativeDriver: true }),
    ]).start(() => done.current());
  }, [ready, fade, shrink]);
  return (
    <Animated.View
      onLayout={() => void SplashScreen.hideAsync().catch(() => undefined)}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading Milagre"
      pointerEvents={ready ? "none" : "auto"}
      style={[
        StyleSheet.absoluteFill,
        {
          zIndex: 100,
          backgroundColor: page,
          alignItems: "center",
          justifyContent: "center",
          opacity: fade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
        },
      ]}
    >
      <Animated.View style={{ transform: [{ scale: shrink.interpolate({ inputRange: [0, 1], outputRange: [1, 0.9] }) }] }}>
        <LoadingLogo />
      </Animated.View>
    </Animated.View>
  );
}

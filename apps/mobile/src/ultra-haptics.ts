import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

const PULSES: [number, Haptics.ImpactFeedbackStyle][] = [
  [0, Haptics.ImpactFeedbackStyle.Heavy],
  [90, Haptics.ImpactFeedbackStyle.Heavy],
  [180, Haptics.ImpactFeedbackStyle.Heavy],
  [320, Haptics.ImpactFeedbackStyle.Rigid],
];

/** Picking Ultra (Ultracode on, or the ultra effort level): the phone rumbles. iOS only, like the app's other haptics. */
export function ultraRumble() {
  if (Platform.OS !== "ios") return;
  for (const [delay, style] of PULSES) setTimeout(() => void Haptics.impactAsync(style).catch(() => {}), delay);
}

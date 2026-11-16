import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import { renderAvatarSvg, type AvatarDefinition, type AvatarMotion } from "open-bot-avatar";
import { MASCOT_COLORS, ORCHESTRATOR_MASCOT } from "@milagre/shared/orchestrator";
import { useReducedMotion } from "./motion";
import { radius } from "./design-tokens";
import { useTheme } from "./theme";

export type MascotMood = AvatarMotion;
export type MascotGaze = { x: number; y: number } | null;

const DEFINITION = ORCHESTRATOR_MASCOT as unknown as AvatarDefinition;
const FRAME_MS = 100;
const BLEND_SECONDS = 0.4;

function useClock(running: boolean) {
  const [time, setTime] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    const timer = setInterval(() => setTime((Date.now() - start) / 1000), FRAME_MS);
    return () => clearInterval(timer);
  }, [running]);
  return time;
}

/** Pebble, the Orchestrator's mascot, drawn as a static SVG; `live` steps its idle motion and blinking a few times a second. */
export function Mascot({
  size,
  color = MASCOT_COLORS[0],
  mood = "idle",
  gaze = null,
  live = false,
  label,
}: {
  size: number;
  color?: string;
  mood?: MascotMood;
  gaze?: MascotGaze;
  live?: boolean;
  label?: string;
}) {
  const reduced = useReducedMotion();
  const { colors, scheme } = useTheme();
  const backed = scheme === "light" && color?.toLowerCase() === MASCOT_COLORS[0];
  const time = useClock(live && !reduced);
  const [shift, setShift] = useState<{ mood: MascotMood; at: number; from: MascotMood }>({ mood, at: -BLEND_SECONDS, from: mood });
  if (shift.mood !== mood) setShift({ mood, at: time, from: shift.mood });
  const blend = reduced ? 1 : Math.min(1, (time - shift.at) / BLEND_SECONDS);
  const from = shift.from;
  const gx = gaze ? Math.round(gaze.x * 20) / 20 : null;
  const gy = gaze ? Math.round(gaze.y * 20) / 20 : null;
  const xml = useMemo(
    () =>
      renderAvatarSvg(DEFINITION, {
        color,
        size,
        motion: mood,
        time,
        reducedMotion: reduced,
        ...(gx !== null && gy !== null ? { gaze: { x: gx, y: gy } } : {}),
        ...(blend < 1 ? { motionBlend: { from, t: blend } } : {}),
      }).replace(/<title>[^<]*<\/title>/, ""),
    [color, size, mood, time, reduced, gx, gy, blend, from],
  );
  return (
    <View
      accessible={!!label}
      accessibilityRole={label ? "image" : undefined}
      accessibilityLabel={label}
      accessibilityElementsHidden={!label}
      importantForAccessibility={label ? "yes" : "no-hide-descendants"}
      style={{ width: size, height: size, ...(backed ? { borderRadius: radius.full, backgroundColor: colors.field } : null) }}
    >
      <SvgXml xml={xml} width={size} height={size} />
    </View>
  );
}

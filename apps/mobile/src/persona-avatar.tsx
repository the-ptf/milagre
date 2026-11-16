import { useMemo } from "react";
import { SvgXml } from "react-native-svg";
import { renderAvatarSvg } from "open-bot-avatar";
import type { QaPersona } from "@milagre/shared/qa-personas";

/** A QA persona's Open Bot Avatar as one still SVG, in the pose its subagent's state calls for. */
export function PersonaAvatar({ persona, size, mood = "idle" }: { persona: QaPersona; size: number; mood?: "idle" | "thinking" | "happy" }) {
  const xml = useMemo(
    () => renderAvatarSvg(persona.avatar, { color: persona.color, size, motion: mood, reducedMotion: true }).replace(/<title>[^<]*<\/title>/, ""),
    [persona, size, mood],
  );
  return <SvgXml xml={xml} width={size} height={size} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />;
}

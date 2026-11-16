import { useEffect, useRef } from "react";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import type { QaPersona } from "@milagre/shared/qa-personas";
import { useMotionScale } from "../../lib/ease";

/** A QA persona's Open Bot Avatar: live (blinking, and thinking while its subagent works) unless `still`. */
export function PersonaAvatar({
  persona,
  size,
  mood = "idle",
  still = false,
  overlap,
}: {
  persona: QaPersona;
  size: number;
  mood?: "idle" | "thinking" | "happy";
  still?: boolean;
  overlap?: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const reducedMotion = useMotionScale() === 0 ? true : "system";
  useEffect(() => {
    if (!host.current) return;
    avatar.current = mountAvatar(host.current, { definition: persona.avatar, color: persona.color, mood, reducedMotion, still, label: "" });
    return () => {
      avatar.current?.destroy();
      avatar.current = null;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mounts once per persona; the effect below pushes later changes through update()
  }, [persona.type, still]);
  useEffect(() => {
    avatar.current?.update({ mood, reducedMotion });
  }, [mood, reducedMotion]);
  return (
    <span
      ref={host}
      aria-hidden
      data-qa-persona={persona.type}
      className={`inline-block shrink-0 ${overlap ? "-ml-1.5 first:ml-0" : ""}`}
      style={{ width: size, height: size }}
    />
  );
}

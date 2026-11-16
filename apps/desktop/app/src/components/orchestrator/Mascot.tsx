import { useEffect, useRef, type CSSProperties } from "react";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import { ORCHESTRATOR_MASCOT } from "@milagre/shared/orchestrator";
import { useMotionScale } from "../../lib/ease";

export type MascotMood = "idle" | "thinking" | "happy";
export type Look = { x: number; y: number } | null;

const WHITE = /^(#fff|#ffffff|white)$/i;

export function Mascot({
  size,
  color,
  mood = "idle",
  look = null,
  followPointer = false,
  label = "",
  className = "",
  style,
  ...data
}: {
  size: number;
  color: string;
  mood?: MascotMood;
  look?: Look;
  followPointer?: boolean;
  label?: string;
  className?: string;
  style?: CSSProperties;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const reducedMotion = useMotionScale() === 0 ? true : "system";
  const lookKey = look ? `${Math.round(look.x * 20)},${Math.round(look.y * 20)}` : "";
  useEffect(() => {
    if (!host.current) return;
    avatar.current = mountAvatar(host.current, { definition: ORCHESTRATOR_MASCOT, color, mood, lookAt: look, followPointer, label, reducedMotion });
    return () => {
      avatar.current?.destroy();
      avatar.current = null;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mounts once; the effects below push every later change through update()
  }, []);
  useEffect(() => {
    avatar.current?.update({ color, mood, followPointer, reducedMotion, label });
  }, [color, mood, followPointer, reducedMotion, label]);
  useEffect(() => {
    avatar.current?.update({ lookAt: look });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a gaze that moves less than a twentieth isn't worth a redraw
  }, [lookKey]);
  return (
    <span
      {...data}
      role={label ? "img" : undefined}
      aria-hidden={label ? undefined : true}
      className={`relative inline-block shrink-0 ${className}`}
      style={{ width: size, height: size, ...style }}
    >
      {WHITE.test(color.trim()) && <span aria-hidden data-mascot-disc className="absolute inset-[6%] rounded-full bg-field shadow-hairline dark:hidden" />}
      <span ref={host} className="absolute inset-0" />
    </span>
  );
}

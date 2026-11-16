import { useEffect, useMemo, useRef, type ReactNode, type Ref } from "react";
import { useMotionScale } from "../../lib/ease";

export type ReelItem = { key: string; node: ReactNode };
export type ReelPhase = "wait" | "spin" | "land" | "done";

const ROW = 18;
const SPIN_MS = 55;
const LAND_ROWS = 14;
const LAND_MS = 900;
const LAND_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

function strip(items: readonly ReelItem[], final: ReelItem | null, length: number): ReelItem[] {
  const others = items.filter((item) => item.key !== final?.key);
  const pool = others.length ? others : final ? [final] : [];
  const out = Array.from({ length }, (_, index) => pool[index % Math.max(1, pool.length)]).filter((item): item is ReelItem => Boolean(item));
  return final ? [...out, final] : out;
}

export function Reel({
  items,
  final,
  phase,
  badge = false,
  onLanded,
  ref,
}: {
  items: readonly ReelItem[];
  final: ReelItem | null;
  phase: ReelPhase;
  badge?: boolean;
  onLanded?: () => void;
  ref?: Ref<HTMLSpanElement>;
}) {
  const scale = useMotionScale();
  const track = useRef<HTMLSpanElement>(null);
  const landed = useRef(onLanded);
  landed.current = onLanded;
  const spinning = useMemo(() => strip(items, null, Math.max(4, Math.min(items.length, 8))), [items]);
  const landing = useMemo(() => strip(items, final, LAND_ROWS), [items, final]);
  useEffect(() => {
    const node = track.current;
    if (!node || scale === 0) {
      if (phase === "land") landed.current?.();
      return;
    }
    if (phase === "spin" && spinning.length > 1) {
      const animation = node.animate([{ transform: "translateY(0)" }, { transform: `translateY(-${ROW * spinning.length}px)` }], {
        duration: SPIN_MS * spinning.length * scale,
        iterations: Infinity,
        easing: "linear",
      });
      return () => animation.cancel();
    }
    if (phase !== "land") return;
    const distance = ROW * (landing.length - 1);
    const animation = node.animate(
      [
        { transform: "translateY(0)", filter: "blur(0.6px)" },
        { transform: `translateY(-${distance + 4}px)`, filter: "blur(0)", offset: 0.82 },
        { transform: `translateY(-${distance}px)` },
      ],
      { duration: LAND_MS * scale, easing: LAND_EASE, fill: "forwards" },
    );
    animation.onfinish = () => landed.current?.();
    return () => animation.cancel();
  }, [phase, scale, spinning, landing]);
  const shell = `relative inline-flex h-[18px] shrink-0 overflow-hidden align-middle ${badge ? "rounded-inline bg-field px-1.5 text-10 font-medium text-ink-2" : ""}`;
  if (phase === "done" && final)
    return (
      <span ref={ref} data-reel="done" className={shell} style={{ animation: scale ? "pop-in var(--duration-base) var(--ease-enter) backwards" : undefined }}>
        <span className="flex h-[18px] items-center gap-1.5 whitespace-nowrap">{final.node}</span>
      </span>
    );
  const rows = phase === "land" ? landing : phase === "spin" ? [...spinning, ...spinning] : [];
  return (
    <span ref={ref} data-reel={phase} className={`${shell} text-ink-3`}>
      {rows.length === 0 || scale === 0 ? (
        <span
          className="flex h-[18px] items-center"
          style={phase === "spin" ? { animation: "reduced-motion-loading 1.6s steps(2, jump-none) infinite alternate" } : undefined}
        >
          …
        </span>
      ) : (
        <span ref={track} className="flex flex-col" style={phase === "spin" ? { filter: "blur(0.6px)" } : undefined}>
          {rows.map((item, index) => (
            <span key={`${item.key}-${index}`} className="flex h-[18px] items-center gap-1.5 whitespace-nowrap">
              {item.node}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

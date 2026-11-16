import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMotionScale } from "../../lib/ease";
import { Mascot } from "./Mascot";

const MINI = 14;
const HOP_MS = 320;
const JOBS = [[0, 3], [1], [2]] as const;

type Stage = "whole" | "split" | "merged";
type Point = { x: number; y: number };

function centre(box: HTMLElement, node: Element, lift = 0): Point {
  const outer = box.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  return { x: rect.left - outer.left + rect.width / 2 - MINI / 2, y: rect.top - outer.top + (rect.height - MINI) / 2 - lift };
}

/** The mascot beside a title splits into three that hop onto the picked chips at once, then merge back. */
export function SplitPicker({
  title,
  chips,
  picked,
  color,
  size = 20,
  onDone,
}: {
  title: ReactNode;
  chips: readonly ReactNode[];
  picked: boolean;
  color: string;
  size?: number;
  onDone?: () => void;
}) {
  const scale = useMotionScale();
  const box = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLSpanElement>(null);
  const chipNodes = useRef<(HTMLSpanElement | null)[]>([]);
  const minis = useRef<(HTMLSpanElement | null)[]>([]);
  const [stage, setStage] = useState<Stage>("whole");
  const [landed, setLanded] = useState<ReadonlySet<number>>(() => new Set());
  const done = useRef(onDone);
  done.current = onDone;
  const count = chips.length;
  useEffect(() => {
    if (!picked) return;
    const all = new Set(Array.from({ length: count }, (_, index) => index));
    if (scale === 0) {
      setLanded(all);
      setStage("merged");
      done.current?.();
      return;
    }
    let live = true;
    const timers: number[] = [];
    const wait = (ms: number) => new Promise<void>((resolve) => timers.push(window.setTimeout(resolve, ms * scale)));
    const move = (index: number, to: Point, hop = true) => {
      const node = minis.current[index];
      if (!node) return;
      node.style.transform = `translate(${to.x}px, ${to.y}px)`;
      const body = node.firstElementChild as HTMLElement | null;
      if (!hop || !body) return;
      body.classList.remove("orchestrator-hop");
      void body.offsetWidth;
      body.classList.add("orchestrator-hop");
    };
    void (async () => {
      const outer = box.current;
      const home = outer && main.current ? centre(outer, main.current) : { x: 0, y: 0 };
      JOBS.forEach((_, index) => move(index, home, false));
      setStage("split");
      await wait(120);
      JOBS.forEach((_, index) => move(index, { x: home.x + (index - 1) * 16, y: home.y - 6 }));
      await wait(260);
      await Promise.all(
        JOBS.map(async (list, mini) => {
          await wait(mini * 90);
          for (const chip of list) {
            const node = chipNodes.current[chip];
            if (!live || !outer || !node) continue;
            move(mini, centre(outer, node));
            await wait(HOP_MS);
            if (!live) return;
            setLanded((current) => new Set(current).add(chip));
            move(mini, centre(outer, node, 16));
            await wait(240);
          }
        }),
      );
      if (!live) return;
      setLanded(all);
      JOBS.forEach((_, index) => move(index, home));
      await wait(HOP_MS);
      if (!live) return;
      setStage("merged");
      await wait(400);
      if (live) done.current?.();
    })();
    return () => {
      live = false;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [picked, scale, count]);
  const pop = `transform ${200 * scale}ms cubic-bezier(0.2, 1.6, 0.4, 1), opacity ${150 * scale}ms`;
  return (
    <div ref={box} className="relative flex flex-col gap-1.5">
      <div className="flex items-start gap-2 pr-7">
        <span ref={main} className="mt-0.5 flex shrink-0" style={{ transition: pop, transform: stage === "split" ? "scale(0)" : "none" }}>
          <Mascot size={size} color={color} mood={stage === "merged" ? "happy" : "thinking"} look={stage === "merged" ? null : { x: 0.2, y: 0.8 }} />
        </span>
        <span className="min-w-0 text-13 font-medium text-ink">{title}</span>
      </div>
      {count > 0 && (
        <div className="flex flex-wrap gap-1.5" style={{ paddingLeft: size + 8 }}>
          {chips.map((chip, index) => (
            <span
              key={index}
              ref={(node) => {
                chipNodes.current[index] = node;
              }}
              data-picked-chip={landed.has(index) ? "on" : "off"}
              className="flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-line bg-field px-2 text-12 whitespace-nowrap text-ink"
              style={{
                transition: `transform ${350 * scale}ms cubic-bezier(0.2, 1.7, 0.4, 1), opacity ${150 * scale}ms`,
                opacity: landed.has(index) ? 1 : 0,
                transform: landed.has(index) ? "none" : "scale(0.3) translateY(4px)",
              }}
            >
              {chip}
            </span>
          ))}
        </div>
      )}
      {JOBS.map((_, index) => (
        <span
          key={index}
          aria-hidden
          ref={(node) => {
            minis.current[index] = node;
          }}
          className="pointer-events-none absolute top-0 left-0 z-10 flex"
          style={{
            opacity: stage === "split" ? 1 : 0,
            transition: `transform ${HOP_MS * scale}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${120 * scale}ms`,
          }}
        >
          <span className="flex" style={{ animationDuration: `${HOP_MS * scale}ms` }}>
            <Mascot size={MINI} color={color} mood="thinking" look={{ x: 0.2, y: 0.7 }} />
          </span>
        </span>
      ))}
    </div>
  );
}

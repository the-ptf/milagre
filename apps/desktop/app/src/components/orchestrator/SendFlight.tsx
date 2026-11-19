import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useMotionScale } from "../../lib/ease";
import { Mascot } from "./Mascot";

/** `rest` is where the Pebble settles after the drop; without it, it flies back to `bot`, where it took off. */
export type Flight = { id: string; text: string; from: DOMRect; bot: DOMRect; rest?: DOMRect };

const BOT = 36;
const CARRY_MS = 1500;
const RETURN_MS = 650;
const SLIDE = "cubic-bezier(0.32, 0.72, 0, 1)";

type Box = { left: number; top: number; width: number; height: number };
const at = (x: number, y: number, scale = 1) => `translate(${x}px, ${y}px) scale(${scale})`;

function targetBox(id: string): Box {
  const card = document.querySelector(`[data-task-card="${CSS.escape(id)}"]`) ?? document.querySelector("[data-orchestrator-row]");
  const box = card?.getBoundingClientRect();
  return box?.width
    ? { left: box.left, top: box.top, width: box.width, height: box.height }
    : { left: 24, top: window.innerHeight - 120, width: 240, height: 96 };
}

export function SendFlight({ flight, color, onLand, onDone }: { flight: Flight; color: string; onLand: () => void; onDone: () => void }) {
  const note = useRef<HTMLDivElement>(null);
  const bot = useRef<HTMLDivElement>(null);
  const scale = useMotionScale();
  const handlers = useRef({ onLand, onDone });
  handlers.current = { onLand, onDone };

  useLayoutEffect(() => {
    if (scale === 0 || !note.current || !bot.current) {
      handlers.current.onLand();
      handlers.current.onDone();
      return;
    }
    const from = flight.from;
    const home = flight.bot;
    const to = targetBox(flight.id);
    const botX = (box: Box) => box.left + box.width / 2 - BOT / 2;
    const botY = (box: Box) => box.top - BOT + 12;
    const mid = { left: (from.left + to.left) / 2 + 40, top: Math.max(BOT, Math.min(from.top, to.top) - 60), width: to.width, height: 60 };
    const homeAt = at(home.left, home.top, home.width / BOT);
    const rest = flight.rest ?? home;
    const restAt = at(rest.left, rest.top, rest.width / BOT);
    const carry = bot.current.animate(
      [
        { transform: homeAt, offset: 0, easing: SLIDE },
        { transform: at(botX(from), botY(from) - 24), offset: 0.28, easing: "ease-in-out" },
        { transform: at(botX(from), botY(from)), offset: 0.36, easing: "ease-in" },
        { transform: at(botX(from), botY(from) - 10), offset: 0.44, easing: "cubic-bezier(0.45, 0, 0.2, 1)" },
        { transform: at(botX(mid), botY(mid)), offset: 0.72, easing: "cubic-bezier(0.3, 0, 0.2, 1)" },
        { transform: at(botX(to), botY(to)), offset: 1 },
      ],
      { duration: CARRY_MS * scale, fill: "forwards" },
    );
    const size = (box: Box) => ({ width: `${box.width}px`, height: `${box.height}px` });
    const paper = note.current.animate(
      [
        { transform: at(from.left, from.top), ...size(from), offset: 0 },
        { transform: at(from.left, from.top), ...size(from), offset: 0.36, easing: "ease-out" },
        { transform: at(from.left, from.top - 10), ...size(from), offset: 0.44, easing: "cubic-bezier(0.45, 0, 0.2, 1)" },
        { transform: at(mid.left, mid.top), ...size(mid), offset: 0.72, easing: "cubic-bezier(0.3, 0, 0.2, 1)" },
        { transform: at(to.left, to.top), ...size(to), offset: 1 },
      ],
      { duration: CARRY_MS * scale, fill: "forwards" },
    );
    let back: Animation | null = null;
    paper.onfinish = () => {
      handlers.current.onLand();
      note.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180 * scale, fill: "forwards" });
      back =
        bot.current?.animate([{ transform: at(botX(to), botY(to)) }, { transform: at(botX(to), botY(to) - 18), offset: 0.25 }, { transform: restAt }], {
          duration: RETURN_MS * scale,
          delay: 120 * scale,
          easing: SLIDE,
          fill: "forwards",
        }) ?? null;
      if (back) back.onfinish = () => handlers.current.onDone();
      else handlers.current.onDone();
    };
    return () => {
      carry.cancel();
      paper.cancel();
      back?.cancel();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- one flight per mount; the page remounts it for the next send
  }, []);

  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[70]">
      <div
        ref={note}
        className="absolute top-0 left-0 overflow-hidden rounded-card bg-surface px-3 py-2.5 text-13 text-ink shadow-raised"
        style={{ transform: at(flight.from.left, flight.from.top), width: flight.from.width, height: flight.from.height }}
      >
        {flight.text}
      </div>
      <div
        ref={bot}
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: BOT, height: BOT, transform: at(flight.bot.left, flight.bot.top, flight.bot.width / BOT) }}
      >
        <Mascot size={BOT} color={color} mood="happy" />
      </div>
    </div>,
    document.body,
  );
}

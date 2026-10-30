import { motion, useReducedMotion } from "motion/react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import voice from "../assets/ultracode.mp3";

const SECONDS = 2.6;
const LETTERS = "ULTRACODE".split("");
// Sparks that burst out of the word in jittery hops and flicker as they fade: a fixed scatter so every run looks the same.
const DOTS = Array.from({ length: 120 }, (_, index) => {
  const angle = index * 2.399963; // golden angle spreads them evenly
  const reach = 120 + ((index * 53) % 260);
  const jitter = (n: number) => (((index * n) % 41) - 20) * 1.6;
  const x = Math.cos(angle) * reach * 2;
  const y = Math.sin(angle) * reach;
  return {
    x: [0, x * 0.35 + jitter(7), x * 0.6 - jitter(11), x * 0.85 + jitter(13), x],
    y: [0, y * 0.35 - jitter(17), y * 0.6 + jitter(19), y * 0.85 - jitter(23), y - 20],
    size: 4 + (index % 5) * 1.5,
    delay: 0.12 + ((index * 37) % 120) / 100,
    duration: 0.55 + ((index * 17) % 45) / 100,
  };
});

/** Turning Ultracode on, Mortal Kombat style in Milagre purple: the window darkens and shakes, ULTRACODE slams in, dots float out of it, and the
 * announcer says it. Plays once per mount over the whole window. Reduced motion keeps the word and the voice, not the slam. */
export function UltracodeFatality({ onDone }: { onDone: () => void }) {
  const reduce = useReducedMotion();

  useEffect(() => {
    const audio = new Audio(voice);
    audio.volume = 0.8;
    // A blocked or missing clip leaves the animation alone.
    audio.play().catch(() => {});
    return () => audio.pause();
  }, []);

  return createPortal(
    <motion.div
      aria-hidden
      data-ultracode-fatality
      className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 1, 0] }}
      transition={{ duration: SECONDS, times: [0, 0.06, 0.82, 1], ease: "easeOut" }}
      onAnimationComplete={onDone}
    >
      <div className="absolute inset-0 bg-black/80" />
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at center, transparent 30%, rgba(76,29,149,0.6) 100%)" }} />
      <motion.div
        className="relative"
        animate={reduce ? undefined : { x: [0, -14, 12, -9, 7, -4, 2, 0], y: [0, 8, -10, 6, -4, 2, 0, 0] }}
        transition={{ duration: 0.5, delay: 0.18, ease: "easeOut" }}
      >
        <motion.div
          className="relative flex"
          initial={reduce ? { opacity: 0 } : { scale: 3.2, opacity: 0 }}
          animate={reduce ? { opacity: 1 } : { scale: [3.2, 0.94, 1], opacity: [0, 1, 1] }}
          transition={{ duration: 0.32, delay: 0.08, ease: [0.2, 0.9, 0.3, 1] }}
        >
          {LETTERS.map((letter, index) => (
            <span
              key={index}
              className="text-[min(13vw,160px)] leading-none tracking-[0.04em]"
              style={{
                fontFamily: "Creepster, Impact, sans-serif",
                color: "var(--purple)",
                backgroundImage: "linear-gradient(180deg, #f0abfc 0%, var(--purple) 45%, #4c1d95 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                // The stroke paints over the fill and eats into Creepster's heavy strokes, so the letters read thinner.
                WebkitTextStroke: "5px #12051f",
                filter: "drop-shadow(0 0 2px #000) drop-shadow(0 0 22px rgba(168,85,247,0.6)) drop-shadow(0 6px 0 #000)",
              }}
            >
              {letter}
            </span>
          ))}
          {!reduce &&
            DOTS.map((dot, index) => (
              <motion.span
                key={index}
                className="absolute top-1/2 left-1/2 rounded-full"
                style={{
                  width: dot.size,
                  height: dot.size,
                  background: index % 3 === 0 ? "#f0abfc" : "#c084fc",
                  boxShadow: "0 0 12px 2px rgba(192,132,252,0.9)",
                }}
                initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
                animate={{ x: dot.x, y: dot.y, opacity: [0, 1, 0.35, 1, 0], scale: [0.4, 1.3, 0.8, 1.1, 0.5] }}
                transition={{ duration: dot.duration, delay: dot.delay, ease: "linear" }}
              />
            ))}
        </motion.div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

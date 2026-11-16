import { useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type Ref } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { EASE_OUT as EASE, useMotionScale } from "../../lib/ease";
import { Icon } from "./Icon";

const EASE_OUT: Transition["ease"] = [...EASE];
const PILL_IN: Transition = { duration: 0.26, ease: EASE_OUT };

// Each tone sets the glass tint and ring the .status-pill surface draws (styles.css), and the text colour. Focus stays the
export const PILL_TONES = {
  ink: "text-ink-2",
  orange: "text-orange-ink [--status-pill-tint:var(--orange)] [--status-pill-ring:color-mix(in_oklab,var(--orange)_25%,transparent)]",
  green: "text-green-ink [--status-pill-tint:var(--green)] [--status-pill-ring:color-mix(in_oklab,var(--green)_25%,transparent)]",
  red: "text-red-ink [--status-pill-tint:var(--red)] [--status-pill-ring:color-mix(in_oklab,var(--red)_25%,transparent)]",
} as const;

const useMotionOff = () => useMotionScale() === 0;

export function PillSlot({
  children,
  className = "flex",
  slot,
  ref,
  style,
  still = false,
}: {
  children: ReactNode;
  className?: string;
  slot: string;
  ref?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  /** No layout slide: a transform would become the containing block of a fixed descendant (an expanded PillMorph). */
  still?: boolean;
}) {
  const reduced = useMotionOff();
  const hidden = reduced ? { opacity: 0 } : { opacity: 0, scale: 0.85 };
  return (
    <motion.div
      ref={ref}
      layout={still ? false : "position"}
      data-slot={slot}
      className={className}
      style={style}
      initial={hidden}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ ...hidden, transition: { duration: reduced ? 0 : 0.14 } }}
      transition={reduced ? { duration: 0 } : { ...PILL_IN, delay: 0.09, layout: PILL_IN, opacity: { duration: 0.16, delay: 0.09 } }}
    >
      {children}
    </motion.div>
  );
}

export function StatusPill({
  icon,
  leading,
  label,
  count,
  total,
  tone = "ink",
  bare = false,
  className = "",
  ref,
  ...props
}: {
  icon?: IconSvgElement;
  leading?: ReactNode;
  label?: string;
  count?: number;
  total?: number;
  tone?: keyof typeof PILL_TONES;
  bare?: boolean;
  ref?: Ref<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={`flex h-7 items-center gap-1.5 rounded-full px-2.5 text-12 whitespace-nowrap transition-colors focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40 ${bare ? "hover:bg-hover focus-visible:-outline-offset-2" : "status-pill"} ${PILL_TONES[tone]} ${className}`}
    >
      {leading}
      {icon && <Icon icon={icon} size={12} />}
      {label !== undefined && <Letters text={label} />}
      {label !== undefined && count !== undefined && " "}
      {count !== undefined && (
        <span className="flex tabular-nums">
          <RollingNumber value={count} />
          {total !== undefined && (
            <>
              /<RollingNumber value={total} />
            </>
          )}
        </span>
      )}
    </button>
  );
}

function Letters({ text }: { text: string }) {
  const reduced = useMotionOff();
  const [shown, setShown] = useState({ text, generation: 0 });
  if (shown.text !== text) setShown({ text, generation: shown.generation + 1 });
  if (!shown.generation || reduced) return <span>{text}</span>;
  return (
    <span key={shown.generation} className="relative whitespace-pre">
      <span className="sr-only">{text}</span>
      {[...text].map((letter, index) => (
        <motion.span
          key={index}
          aria-hidden
          data-letter={letter}
          className="inline-block before:content-[attr(data-letter)]"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: EASE_OUT, delay: Math.min(index * 0.018, 0.3) }}
        />
      ))}
    </span>
  );
}

function RollingNumber({ value }: { value: number }) {
  const [last, setLast] = useState({ value, direction: 1 });
  if (last.value !== value) setLast({ value, direction: value > last.value ? 1 : -1 });
  const digits = [...String(value)];
  return (
    <span className="relative inline-flex">
      <span className="sr-only">{value}</span>
      <AnimatePresence initial={false} mode="popLayout">
        {digits.map((digit, index) => (
          <motion.span key={digits.length - index} layout="position" aria-hidden className="inline-flex" exit={{ opacity: 0 }}>
            <Digit digit={digit} direction={last.direction} />
          </motion.span>
        ))}
      </AnimatePresence>
    </span>
  );
}

function Digit({ digit, direction }: { digit: string; direction: number }) {
  const reduced = useMotionOff();
  const travel = reduced ? 0 : direction;
  return (
    <span className="relative inline-flex h-[1lh] overflow-hidden">
      <span data-digit={digit} aria-hidden className="invisible before:content-[attr(data-digit)]" />
      <AnimatePresence initial={false} custom={travel}>
        <motion.span
          key={digit}
          custom={travel}
          variants={{
            enter: (dir: number) => ({ y: `${dir * 100}%`, opacity: dir ? 0 : 1 }),
            shown: { y: "0%", opacity: 1 },
            leave: (dir: number) => ({ y: `${-dir * 100}%`, opacity: dir ? 0 : 1 }),
          }}
          initial="enter"
          animate="shown"
          exit="leave"
          transition={{ duration: reduced ? 0 : 0.28, ease: EASE_OUT }}
          data-digit={digit}
          aria-hidden
          className="absolute inset-0 before:content-[attr(data-digit)]"
        />
      </AnimatePresence>
    </span>
  );
}

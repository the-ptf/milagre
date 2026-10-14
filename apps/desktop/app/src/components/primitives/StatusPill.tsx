import { useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type Ref } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";

const EASE_OUT: Transition["ease"] = [0.23, 1, 0.32, 1];
const PILL_IN: Transition = { duration: 0.26, ease: EASE_OUT };

// Each tone sets the glass tint and ring the .status-pill surface draws (styles.css), and the text colour.
export const PILL_TONES = {
  ink: "text-ink-2",
  orange: "text-orange [--status-pill-tint:var(--orange)] [--status-pill-ring:color-mix(in_oklab,var(--orange)_25%,transparent)] focus-visible:outline-orange",
  red: "text-red [--status-pill-tint:var(--red)] [--status-pill-ring:color-mix(in_oklab,var(--red)_25%,transparent)] focus-visible:outline-red",
} as const;

/**
 * One slot in the composer's chip row (the PR fix, Ports, to-dos, Browser, Simulators, Subagents). It grows in from a
 * slightly smaller size and shrinks out, and its neighbours slide over, inside the row's LayoutGroup. A pill already
 * there when the chat opens does not animate: wrap the slot in `<AnimatePresence initial={false}>`.
 */
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
  const reduced = useReducedMotion();
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
      exit={{ ...hidden, transition: { duration: 0.14 } }}
      // The pill shows once its neighbours have started to slide, so it never draws over one still in its old place.
      transition={{ ...PILL_IN, delay: 0.09, layout: PILL_IN, opacity: { duration: 0.16, delay: 0.09 } }}
    >
      {children}
    </motion.div>
  );
}

/**
 * The composer row's pill: 24px, frosted glass over the transcript, its count rolling to each new value and a
 * changed label fading in letter by letter. `count` and `total` show as "count" or "count/total".
 */
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
  /** Inside a PillMorph, whose surface draws the glass and border. */
  bare?: boolean;
  ref?: Ref<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={`flex h-6 items-center gap-1.5 rounded-full px-2 text-[11px] whitespace-nowrap transition-colors focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50 ${bare ? "hover:bg-hover focus-visible:-outline-offset-2" : "status-pill"} ${PILL_TONES[tone]} ${className}`}
    >
      {leading}
      {icon && <HugeiconsIcon icon={icon} size={12} aria-hidden />}
      {label !== undefined && <Letters text={label} />}
      {/* A space for textContent and screen readers; flex layout drops it and the gap spaces the two. */}
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

/** The label whole; when it changes, its letters rise in one after another. */
function Letters({ text }: { text: string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState({ text, generation: 0 });
  if (shown.text !== text) setShown({ text, generation: shown.generation + 1 });
  if (!shown.generation || reduced) return <span>{text}</span>;
  return (
    <span key={shown.generation} className="relative whitespace-pre">
      {/* The label as text, once; the rising letters are drawn from data-letter. */}
      <span className="sr-only">{text}</span>
      {[...text].map((letter, index) => (
        // The letters only ever remount together (the span is keyed by generation), so an index key is stable.
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

/** An odometer: each digit place rolls to its new digit, upward when the number grows and downward when it shrinks. */
function RollingNumber({ value }: { value: number }) {
  const [last, setLast] = useState({ value, direction: 1 });
  if (last.value !== value) setLast({ value, direction: value > last.value ? 1 : -1 });
  const digits = [...String(value)];
  return (
    <span className="relative inline-flex">
      {/* The value as text, once: the rolling digits are drawn from data-digit, so a leaving digit adds no text. */}
      <span className="sr-only">{value}</span>
      <AnimatePresence initial={false} mode="popLayout">
        {digits.map((digit, index) => (
          // Keyed by place from the right, so the ones digit stays the same element when the number gains a digit.
          <motion.span key={digits.length - index} layout="position" aria-hidden className="inline-flex" exit={{ opacity: 0 }}>
            <Digit digit={digit} direction={last.direction} />
          </motion.span>
        ))}
      </AnimatePresence>
    </span>
  );
}

function Digit({ digit, direction }: { digit: string; direction: number }) {
  const reduced = useReducedMotion();
  const travel = reduced ? 0 : direction;
  return (
    <span className="relative inline-flex h-[1lh] overflow-hidden">
      {/* Holds the width; every animated copy sits over it, so an entering and a leaving digit share the place. */}
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

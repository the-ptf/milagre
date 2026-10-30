import type { ComponentPropsWithRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CommandIcon, OptionIcon } from "@hugeicons/core-free-icons";
import { isMac } from "../../lib/shortcut-hints";

const names: Record<string, string> = {
  "⌘": "Command",
  meta: "Command",
  "⇧": "Shift",
  shift: "Shift",
  "⌥": "Alt",
  alt: "Alt",
  "⌃": "Control",
  ctrl: "Control",
  control: "Control",
  "↵": "Enter",
  enter: "Enter",
  "↑": "Up",
  "↓": "Down",
  esc: "Escape",
  escape: "Escape",
};
const paths: Record<string, string> = {
  Shift: "M8 2.5 14 8H10.5V13.5H5.5V8H2Z",
  Enter: "M12.5 3V8H3M7 4 3 8 7 12",
  Up: "M8 13V3M3.5 7.5 8 3 12.5 7.5",
  Down: "M8 3V13M3.5 8.5 8 13 12.5 8.5",
};

/**
 * One keyboard vocabulary for floating hints, tooltip labels and command rows. A keycap is 20px, 4px corners, surface
 * with shadow-btn, 11 semibold ink-2 (`compact`: 16px, 10); `plain` draws the keys alone, in the surrounding colour.
 */
export function ShortcutKeys({
  shortcut,
  plain = false,
  compact = false,
  className = "",
  ...props
}: {
  shortcut: string;
  plain?: boolean;
  /** Smaller keys, for a hint under one of a row of close icon buttons. */
  compact?: boolean;
} & ComponentPropsWithRef<"kbd">) {
  const all = shortcut.match(/Control|Ctrl|Shift|Alt|Meta|Enter|Escape|Esc|Tab|Space|Del|Home|End|PgUp|PgDn|F[0-9]{1,2}|[^\s+]/gi) ?? [];
  // Off the Mac a compact hint leaves out Ctrl, the key held to show it, and draws Shift as its arrow: "Ctrl Shift E"
  // would run into the next button's hint.
  const keys = compact && !isMac ? all.filter((key) => names[key.toLowerCase()] !== "Control") : all;
  // Drawn glyphs sit at the keycap's text size (12 beside 11px letters, 10 when compact), stroke 1.6 as on the icon scale at 12.
  const glyph = compact ? 10 : 12;
  return (
    <kbd
      {...props}
      data-shortcut-hint
      aria-label={keys.map((key) => names[key.toLowerCase()] ?? key).join(" + ")}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap font-sans font-semibold leading-none tracking-normal tabular-nums ${compact ? "gap-px text-10" : "gap-0.5 text-11"} ${plain ? "" : `rounded-inline bg-surface text-ink-2 shadow-btn ${compact ? "h-4 min-w-4 px-0.5" : "h-5 min-w-5 px-1"}`} ${className}`}
    >
      {keys.map((key, index) => {
        const name = names[key.toLowerCase()] ?? key;
        return (
          <span key={index} aria-hidden="true" className="inline-flex items-center justify-center">
            {name === "Command" ? (
              <HugeiconsIcon icon={CommandIcon} size={glyph} strokeWidth={1.6} />
            ) : paths[name] && (isMac || compact || name !== "Shift") ? (
              <svg
                width={glyph}
                height={glyph}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={paths[name]} />
              </svg>
            ) : name === "Alt" && isMac ? (
              <HugeiconsIcon icon={OptionIcon} size={glyph} strokeWidth={1.6} />
            ) : (
              <span>{name === "Control" ? "Ctrl" : name === "Escape" ? "Esc" : name === "Shift" || name === "Alt" ? name : key}</span>
            )}
          </span>
        );
      })}
    </kbd>
  );
}

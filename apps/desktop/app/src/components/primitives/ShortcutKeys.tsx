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

/** One keyboard vocabulary for floating hints, tooltip labels and command rows. */
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
  return (
    <kbd
      {...props}
      data-shortcut-hint
      aria-label={keys.map((key) => names[key.toLowerCase()] ?? key).join(" + ")}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap font-sans font-semibold leading-none tracking-normal tabular-nums ${compact ? "gap-px text-[10px]" : "gap-[3px] text-[12px]"} ${plain ? "" : `rounded-[5px] border border-line bg-surface text-ink-2 shadow-[0_1px_2px_rgb(0_0_0/0.08)] ${compact ? "h-[18px] px-[3px]" : "h-[22px] px-1.5"}`} ${className}`}
    >
      {keys.map((key, index) => {
        const name = names[key.toLowerCase()] ?? key;
        return (
          <span key={index} aria-hidden="true" className="inline-flex min-w-[7px] items-center justify-center">
            {name === "Command" ? (
              <HugeiconsIcon icon={CommandIcon} size={compact ? 10 : 14} strokeWidth={1.8} />
            ) : paths[name] && (isMac || compact || name !== "Shift") ? (
              <svg
                width={compact ? 10 : 14}
                height={compact ? 10 : 14}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={paths[name]} />
              </svg>
            ) : name === "Alt" && isMac ? (
              <HugeiconsIcon icon={OptionIcon} size={compact ? 10 : 14} strokeWidth={1.8} />
            ) : (
              <span>{name === "Control" ? "Ctrl" : name === "Escape" ? "Esc" : name === "Shift" || name === "Alt" ? name : key}</span>
            )}
          </span>
        );
      })}
    </kbd>
  );
}

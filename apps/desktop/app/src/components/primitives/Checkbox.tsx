import type { ComponentProps } from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";

// shadcn/ui Checkbox, adapted to Milagre's tokens and icon set.
// https://ui.shadcn.com/docs/components/radix/checkbox
const CHECKED = {
  ink: "data-[state=checked]:border-ink data-[state=checked]:bg-ink data-[state=indeterminate]:border-ink data-[state=indeterminate]:bg-ink text-on-ink",
  accent:
    "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent text-on-accent",
};

/** Ink when checked, or the theme accent with `tone="accent"` (Babysit PRs). */
export function Checkbox({ className = "", tone = "ink", ...props }: ComponentProps<typeof CheckboxPrimitive.Root> & { tone?: "ink" | "accent" }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={`peer size-4 shrink-0 rounded-inline border border-ink-3 bg-surface transition-colors disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-red ${CHECKED[tone]} ${className}`}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-content-center text-current">
        {props.checked === "indeterminate" ? (
          <span className="h-0.5 w-2.5 bg-current" />
        ) : (
          <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} aria-hidden />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

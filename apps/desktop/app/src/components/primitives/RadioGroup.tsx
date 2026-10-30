import type { ComponentProps } from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";

// shadcn/ui Radio Group, adapted to Milagre's tokens.
// https://ui.shadcn.com/docs/components/radix/radio-group
export function RadioGroup({ className = "", ...props }: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root data-slot="radio-group" className={`grid gap-3 ${className}`} {...props} />;
}

/** Ink when checked, or the theme accent with `tone="accent"` (Babysit PRs). */
export function RadioGroupItem({ className = "", tone = "ink", ...props }: ComponentProps<typeof RadioGroupPrimitive.Item> & { tone?: "ink" | "accent" }) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={`aspect-square size-4 shrink-0 rounded-full border border-ink-3 bg-surface transition-colors disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-red ${tone === "accent" ? "text-on-accent data-[state=checked]:border-accent data-[state=checked]:bg-accent" : "text-ink data-[state=checked]:border-ink"} ${className}`}
      {...props}
    >
      <RadioGroupPrimitive.Indicator data-slot="radio-group-indicator" className="flex items-center justify-center">
        <span className="size-2 rounded-full bg-current" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

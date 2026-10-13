import type { ComponentProps } from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";

// shadcn/ui Checkbox, adapted to Milagre's tokens and icon set.
// https://ui.shadcn.com/docs/components/radix/checkbox
export function Checkbox({ className = "", ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={`peer size-4 shrink-0 rounded-[4px] border border-ink-3 bg-surface outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-red data-[state=checked]:border-ink data-[state=checked]:bg-ink data-[state=checked]:text-surface data-[state=indeterminate]:border-ink data-[state=indeterminate]:bg-ink data-[state=indeterminate]:text-surface ${className}`}
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

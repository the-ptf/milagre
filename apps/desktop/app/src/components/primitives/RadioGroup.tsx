import type { ComponentProps } from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";

// shadcn/ui Radio Group, adapted to Milagre's tokens.
// https://ui.shadcn.com/docs/components/radix/radio-group
export function RadioGroup({ className = "", ...props }: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root data-slot="radio-group" className={`grid gap-3 ${className}`} {...props} />;
}

export function RadioGroupItem({ className = "", ...props }: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={`aspect-square size-4 shrink-0 rounded-full border border-ink-3 bg-surface text-ink outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-red data-[state=checked]:border-ink ${className}`}
      {...props}
    >
      <RadioGroupPrimitive.Indicator data-slot="radio-group-indicator" className="flex items-center justify-center">
        <span className="size-2 rounded-full bg-current" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

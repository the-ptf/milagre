import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

/** The icon scale in .interface-design/system.md: each size has its stroke (lighter when small, heavier at 18). */
const STROKE = { 12: 1.6, 14: 1.8, 16: 1.8, 18: 2 } as const;
export type IconSize = keyof typeof STROKE;

/** A Hugeicons glyph in the text colour, on the icon scale. Decorative: name the control around it, not the icon. */
export function Icon({ icon, size = 16, className }: { icon: IconSvgElement; size?: IconSize; className?: string }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={STROKE[size]} color="currentColor" className={className} aria-hidden />;
}

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

const STROKE = { 12: 1.6, 14: 1.8, 16: 1.8, 18: 2 } as const;
export type IconSize = keyof typeof STROKE;

export function Icon({ icon, size = 16, className }: { icon: IconSvgElement; size?: IconSize; className?: string }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={STROKE[size]} color="currentColor" className={className} aria-hidden />;
}

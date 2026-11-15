import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";

type IconData = Parameters<typeof HugeiconsIcon>[0]["icon"];

export function Icon({ icon, size = 18 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

/** A setting chosen from side-by-side picture cards, under its group title and outside the rows' card. */
export function ChoiceGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 px-1 text-12 font-medium text-ink-3">{title}</h2>
      {children}
    </section>
  );
}

export const SECONDARY_BUTTON =
  "rounded-control border border-line bg-surface px-3 py-1.5 text-12 font-medium text-ink transition-colors hover:border-line-strong hover:bg-hover disabled:cursor-default disabled:opacity-50";

export const DANGER_BUTTON =
  "rounded-control border border-red/30 bg-red/5 px-3 py-1.5 text-12 font-medium text-red-ink transition-colors hover:bg-red/10 disabled:cursor-default disabled:opacity-50";

import type { ReactNode } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "./Icon";

/**
 * A transcript event between messages (compaction, reload, account switch, a Link): a hairline each side of a centred
 * 12px ink-3 label. `label` is the group's accessible name when the visible content is more than plain text.
 * `leading` replaces the icon (a SpinnerRing while it is under way).
 */
export function TranscriptDivider({
  icon,
  leading,
  label,
  children,
  ...data
}: {
  icon?: IconSvgElement;
  leading?: ReactNode;
  label: string;
  children?: ReactNode;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  return (
    <div {...data} role="group" aria-label={label} className="flex w-full items-center gap-3 py-1 text-12 text-ink-3">
      <span className="h-px flex-1 bg-line" />
      <span className="flex min-w-0 items-center gap-1.5 px-2 py-0.5">
        {leading ?? (icon && <Icon icon={icon} size={12} className="shrink-0" />)}
        {children ?? <span className="min-w-0 truncate">{label}</span>}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

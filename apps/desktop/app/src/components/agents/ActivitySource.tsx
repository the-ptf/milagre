import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiBrain01Icon,
  CommandLineIcon,
  File01Icon,
  Image01Icon,
  PencilEdit02Icon,
  Search01Icon,
  Wrench01Icon,
  PaintBoardIcon,
} from "@hugeicons/core-free-icons";
import type { StepKind, ChatStep } from "../../model";
import { activitySources, stepSource, type ActivitySource as Source } from "@milagre/shared/tool-activity";
import { LinearLogo } from "../ProviderLogo";

const ICONS = {
  shell: CommandLineIcon,
  setup: CommandLineIcon,
  read: File01Icon,
  edit: PencilEdit02Icon,
  search: Search01Icon,
  thinking: AiBrain01Icon,
  image: Image01Icon,
  artifact: PaintBoardIcon,
  other: Wrench01Icon,
};

export function ActivityIcon({ source, size = 14 }: { source: Source; size?: number }) {
  return source.linear ? (
    <LinearLogo size={size} />
  ) : (
    <HugeiconsIcon icon={ICONS[source.kind as StepKind] ?? Wrench01Icon} size={size} strokeWidth={1.8} color="currentColor" />
  );
}

export function StepIcon({ step, size = 14 }: { step: ChatStep; size?: number }) {
  return <ActivityIcon source={stepSource(step)} size={size} />;
}

/** Circular, overlapping source marks stay readable against the transcript in either theme. */
export function ActivitySources({ steps }: { steps: ChatStep[] }) {
  return (
    <span data-slot="activity-sources" aria-hidden className="isolate flex shrink-0 items-center pl-1.5">
      {activitySources(steps).map((source) => (
        <span
          key={source.id}
          title={source.label}
          className="-ml-1.5 flex size-[22px] items-center justify-center rounded-full bg-field text-ink-2 ring-2 ring-page"
        >
          <ActivityIcon source={source} size={13} />
        </span>
      ))}
    </span>
  );
}

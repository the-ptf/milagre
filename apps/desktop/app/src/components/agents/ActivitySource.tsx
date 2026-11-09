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
import { Icon, type IconSize } from "../primitives/Icon";
import Tooltip from "../primitives/Tooltip";

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

function ActivityIcon({ source, size = 14 }: { source: Source; size?: IconSize }) {
  return source.linear ? <LinearLogo size={size} /> : <Icon icon={ICONS[source.kind as StepKind] ?? Wrench01Icon} size={size} />;
}

export function StepIcon({ step, size = 14 }: { step: ChatStep; size?: IconSize }) {
  return <ActivityIcon source={stepSource(step)} size={size} />;
}

// The order the summary names the kinds in ("Thought · read 1 file · searched once · edited 1 file · ran 1 command · used
// 1 tool"), so each glyph sits over its own words. Setup isn't in the summary; images and designs come last.
const SUMMARY_ORDER: StepKind[] = ["thinking", "read", "search", "edit", "shell", "other", "image", "artifact"];

/** The kinds of work a folded reply did, one glyph per kind in the summary's order, at most four, none clipped. */
export function ActivitySources({ steps }: { steps: ChatStep[] }) {
  const sources = activitySources(
    steps.filter((step) => step.kind !== "setup"),
    Infinity,
  )
    .map((source, index) => ({ source, index, rank: SUMMARY_ORDER.indexOf(source.kind as StepKind) }))
    .sort((a, b) => (a.rank === -1 ? 99 : a.rank) - (b.rank === -1 ? 99 : b.rank) || a.index - b.index)
    .slice(0, 4);
  return (
    <span data-slot="activity-sources" aria-hidden className="flex shrink-0 items-center gap-1 text-ink-3">
      {sources.map(({ source }) => (
        <Tooltip key={source.id} label={source.label} className="items-center justify-center">
          <ActivityIcon source={source} size={14} />
        </Tooltip>
      ))}
    </span>
  );
}

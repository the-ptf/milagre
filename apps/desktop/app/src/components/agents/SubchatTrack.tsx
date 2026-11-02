import { useMemo, useState } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { ArrowUp01Icon, CancelCircleIcon, CheckmarkCircle02Icon, Clock01Icon, FavouriteIcon, HelpCircleIcon, StopCircleIcon } from "@hugeicons/core-free-icons";
import { sortSubchats, subchatSummary, type SubchatKind, type SubchatState } from "@milagre/shared/subchat-states";
import type { PermissionDecision, QuestionAnswers } from "../../model";
import { useDisplayNow } from "../../lib/display-clock";
import { useRoutines } from "../../lib/routines";
import { subchatStates, type SubchatSource } from "../../lib/subchat-track";
import { PillMorph } from "../motion/PillMorph";
import { ScrollArea } from "../primitives/ScrollArea";
import { SpinnerRing } from "../primitives/SpinnerRing";

// Each kind's mark (the fill token) and its words (the matching ink token, which holds contrast on the surface).
const TONES: Record<SubchatKind, { fill: string; ink: string; icon?: IconSvgElement }> = {
  "needs-you": { fill: "bg-orange", ink: "text-orange-ink", icon: HelpCircleIcon },
  failed: { fill: "bg-red", ink: "text-red-ink", icon: CancelCircleIcon },
  working: { fill: "bg-accent", ink: "text-accent-ink" },
  holding: { fill: "bg-[var(--purple)]", ink: "text-purple-ink", icon: FavouriteIcon },
  queued: { fill: "bg-ink-4", ink: "text-ink-3", icon: Clock01Icon },
  stopped: { fill: "bg-ink-4", ink: "text-ink-3", icon: StopCircleIcon },
  done: { fill: "bg-green", ink: "text-green-ink", icon: CheckmarkCircle02Icon },
};

// The icon's colour is its ink's fill twin.
const ICON_COLOR: Record<SubchatKind, string> = {
  "needs-you": "text-orange",
  failed: "text-red",
  working: "text-accent",
  holding: "text-[var(--purple)]",
  queued: "text-ink-3",
  stopped: "text-ink-3",
  done: "text-green",
};

const BUTTON = "h-6 shrink-0 rounded-control px-2 text-12 font-medium transition-colors focus-visible:outline-2 active:scale-[0.97]";

/**
 * The Chat's Subchats: a pill above the composer ("1 needs you · 2 working") that morphs into the list of what each one
 * is doing. A row opens its Chat; a question or approval waiting on the user can be answered from the row.
 */
export function SubchatTrack({
  source,
  reports,
  className,
  onOpen,
  onAnswer,
  onRespond,
}: {
  source: SubchatSource;
  /** The latest report each Subchat sent into this Chat's transcript, by Chat key (latestReports). */
  reports: ReadonlyMap<string, string>;
  /** Placement in the composer row. */
  className?: string;
  onOpen: (chatKey: string) => void;
  onAnswer: (chatKey: string, requestId: string, answers: QuestionAnswers) => void;
  onRespond: (chatKey: string, requestId: string, decision: PermissionDecision) => void;
}) {
  const [opened, setOpened] = useState(false);
  const { routines } = useRoutines();
  // Elapsed times tick only while the list is open; the pill's counts don't depend on the clock.
  const now = useDisplayNow(1000, opened);
  const states = useMemo(
    () => sortSubchats(subchatStates({ ...source, routines, reports, now })),
    // `source` is rebuilt by its owner when any of its parts changes.
    [source, routines, reports, now],
  );
  const summary = subchatSummary(states);
  return (
    <PillMorph
      shown={states.length > 0}
      slot="subchat-track"
      panelSlot="subchat-popover"
      title="Subchats"
      tooltip="Chats this Chat delegated work to"
      className={className}
      anchor="left"
      opened={opened}
      onOpenChange={setOpened}
      width={440}
      height={420}
      pill={{
        "aria-label": `Subchats, ${summary.parts.map((part) => part.text).join(", ")}`,
        icon: ArrowUp01Icon,
        leading: (
          <span data-slot="subchat-summary" data-lead={summary.lead ?? undefined} className="flex items-center gap-1.5 text-12">
            {summary.lead === "working" ? (
              <SpinnerRing size={10} color="var(--accent)" />
            ) : (
              <span aria-hidden className={`size-2 shrink-0 rounded-full ${summary.lead ? TONES[summary.lead].fill : "bg-ink-4"}`} />
            )}
            {summary.parts.map((part, index) => (
              <span key={part.kind} className={index === 0 ? "text-ink" : "text-ink-3"}>
                {index > 0 && <span aria-hidden> · </span>}
                {part.text}
              </span>
            ))}
          </span>
        ),
      }}
    >
      {(close) => (
        <ScrollArea as="ul" className="flex flex-col gap-0.5 p-1">
          {states.map((state) => (
            <SubchatRow
              key={state.key}
              state={state}
              onOpen={() => {
                close();
                onOpen(state.key);
              }}
              onAnswer={onAnswer}
              onRespond={onRespond}
            />
          ))}
        </ScrollArea>
      )}
    </PillMorph>
  );
}

function SubchatRow({
  state,
  onOpen,
  onAnswer,
  onRespond,
}: {
  state: SubchatState;
  onOpen: () => void;
  onAnswer: (chatKey: string, requestId: string, answers: QuestionAnswers) => void;
  onRespond: (chatKey: string, requestId: string, decision: PermissionDecision) => void;
}) {
  const tone = TONES[state.kind];
  const request = state.request;
  // A single question with options is answered by one tap; several questions at once are answered in the Chat.
  const asked = request?.kind === "question" && request.questions.length === 1 ? { requestId: request.requestId, question: request.questions[0]! } : undefined;
  return (
    <li data-subchat-row data-kind={state.kind} className={`rounded-control ${state.kind === "needs-you" ? "bg-orange-tint" : ""}`}>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-hover focus-visible:outline-2"
      >
        <span className={`mt-px flex size-4 shrink-0 items-center justify-center ${ICON_COLOR[state.kind]}`}>
          {tone.icon ? <HugeiconsIcon icon={tone.icon} size={16} aria-hidden /> : <SpinnerRing size={14} color="var(--accent)" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-13 font-semibold text-ink">{state.title}</span>
          <span
            className={`mt-0.5 block text-12 ${state.kind === "failed" ? "text-red-ink" : state.kind === "done" ? "line-clamp-2 text-ink-2" : "truncate text-ink-3"}`}
          >
            {state.detail}
          </span>
        </span>
        <span className="flex shrink-0 items-baseline gap-1.5 text-12">
          <span className={`font-medium ${tone.ink}`}>{state.label}</span>
          {state.elapsed && <span className="tabular-nums text-ink-3">{state.elapsed}</span>}
        </span>
      </button>
      {request && (
        <div data-subchat-actions className="flex flex-wrap gap-1.5 pr-2 pb-2 pl-8">
          {asked?.question.options.map((option, index) => (
            <button
              key={option.label}
              type="button"
              onClick={() => onAnswer(state.key, asked.requestId, { [asked.question.id]: [option.label] })}
              className={`${BUTTON} ${index === 0 && option.label.includes("(Recommended)") ? "bg-accent-tint text-accent-ink hover:opacity-80" : "border border-line bg-surface text-ink hover:bg-hover"}`}
            >
              {option.label}
            </button>
          ))}
          {request.kind === "approval" && (
            <>
              <button
                type="button"
                onClick={() => onRespond(state.key, request.request.requestId, "allow")}
                className={`${BUTTON} bg-ink text-surface hover:opacity-90`}
              >
                Allow
              </button>
              <button
                type="button"
                onClick={() => onRespond(state.key, request.request.requestId, "deny")}
                className={`${BUTTON} border border-line bg-surface text-ink hover:bg-hover`}
              >
                Deny
              </button>
            </>
          )}
          <button type="button" onClick={onOpen} className={`${BUTTON} text-ink-2 hover:bg-hover`}>
            Reply…
          </button>
        </div>
      )}
    </li>
  );
}

import { stepDisplayTitle, stepDuration, stepSource } from "@milagre/shared/tool-activity";
import { useDisplayValue } from "./display-clock";
import { ActivityIcon } from "./activity-source";
import { StepOutput } from "./step-output";
import {
  AiBrainIcon,
  CommandLineIcon,
  File01Icon,
  FileEditIcon,
  Image01Icon,
  Search01Icon,
  Wrench01Icon,
  PaintBoardIcon,
  Pulse01Icon,
} from "@hugeicons/core-free-icons";
import type { ChatStep, StepKind } from "@milagre/shared/model";
import type { IconData } from "./icons";
import { ActivityItem } from "./activity-item";
import { Markdown } from "./markdown";
import { useExpandReasoning } from "./chat-display-setting";

const icons: Record<StepKind, IconData> = {
  shell: CommandLineIcon,
  setup: CommandLineIcon,
  read: File01Icon,
  edit: FileEditIcon,
  search: Search01Icon,
  thinking: AiBrainIcon,
  image: Image01Icon,
  artifact: PaintBoardIcon,
  other: Wrench01Icon,
};

/** Tool data adapted to the shared activity presentation; Chat taps open the sheet. */
export function ToolRow({
  step,
  live,
  waiting,
  onPress,
  expanded,
}: {
  step: ChatStep;
  live: boolean;
  waiting: boolean;
  onPress?: () => void;
  expanded?: boolean;
}) {
  const [expandReasoning] = useExpandReasoning();
  const running = live && step.status === "running";
  const duration = useDisplayValue(1000, (now) => stepDuration(step, now), running && step.startedAt != null);
  // The phone left this step's output out, and while its turn streams there is no saved message to fetch it from:
  // say so instead of offering a row that never fills. A saved message's step loads from the daemon.
  const pending = live && !!step.hasDetail && !step.detail;
  return (
    <ActivityItem
      title={stepDisplayTitle(step, running && !waiting)}
      // A step that set a Heartbeat (listed in the activity sheet) wears the Heartbeat's pulse.
      icon={step.routine ? Pulse01Icon : icons[step.kind]}
      leading={step.source || stepSource(step).linear ? <ActivityIcon source={stepSource(step)} /> : undefined}
      summary={step.summary}
      duration={duration}
      error={step.error}
      status={running && waiting ? "Needs approval" : undefined}
      state={step.status === "failed" ? "failed" : running ? (waiting ? "waiting" : "running") : "idle"}
      note={[running && waiting ? "Waiting for approval" : "", step.note, pending && !onPress ? "Output appears when the turn finishes." : ""]
        .filter(Boolean)
        .join(" · ")}
      loading={!!step.hasDetail && !pending}
      expanded={expanded ?? (expandReasoning && step.kind === "thinking")}
      onPress={onPress}
    >
      {step.detail || step.input ? (
        step.kind === "thinking" ? (
          <Markdown text={step.detail ?? ""} streaming={running} />
        ) : (
          <StepOutput step={step} />
        )
      ) : undefined}
    </ActivityItem>
  );
}

import { Text } from "react-native";
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
import { useStyles } from "./ui";
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
export function ToolRow({ step, live, waiting, onPress }: { step: ChatStep; live: boolean; waiting: boolean; onPress?: () => void }) {
  const styles = useStyles();
  const [expandReasoning] = useExpandReasoning();
  const running = live && step.status === "running";
  // The phone left this step's output out, and while its turn streams there is no saved message to fetch it from:
  // say so instead of offering a row that never fills. A saved message's step loads from the daemon.
  const pending = live && !!step.hasDetail && !step.detail;
  return (
    <ActivityItem
      title={step.title}
      startedAt={step.startedAt}
      // A step that set a Heartbeat (listed in the activity sheet) wears the Heartbeat's pulse.
      icon={step.routine ? Pulse01Icon : icons[step.kind]}
      state={step.status === "failed" ? "failed" : running ? (waiting ? "waiting" : "running") : "idle"}
      note={[running && waiting ? "Waiting for approval" : "", step.note, pending && !onPress ? "Output appears when the turn finishes." : ""]
        .filter(Boolean)
        .join(" · ")}
      loading={!!step.hasDetail && !pending}
      expanded={expandReasoning && step.kind === "thinking"}
      onPress={onPress}
    >
      {step.detail ? (
        step.kind === "thinking" ? (
          <Markdown text={step.detail} streaming={running} />
        ) : (
          <Text selectable style={styles.code}>
            {step.detail}
          </Text>
        )
      ) : undefined}
    </ActivityItem>
  );
}

import { Text, View } from "react-native";
import { backgroundLabel } from "@milagre/shared/chat-activity";
import { BubbleChatIcon, GitPullRequestIcon, ShieldAlertIcon, Alert02Icon } from "@hugeicons/core-free-icons";
import type { PullRequest, Subagent } from "@milagre/shared/model";
import { BLOCKERS, pullRequestBlockers } from "@milagre/shared/pr-blockers";
import { chatMarkTone } from "@milagre/shared/chats";
import { agentCounts, MARK_LABEL, type ChatMark } from "./indicators";
import { Icon, SpinnerRing } from "./icons";
import { useTheme } from "./theme";
import { StatusPill } from "./status-pill";

/** Desktop's chat mark slot: a question bubble, an approval shield, a spinning ring, an unread dot, or a faint idle dot. */
export function ChatMarkIcon({ mark, background = 0 }: { mark: ChatMark; background?: number }) {
  const { colors } = useTheme();
  const tone = chatMarkTone(mark);
  const label = mark === "background" && background ? `${backgroundLabel(background)} working` : MARK_LABEL[mark];
  const body =
    mark === "background" ? (
      <BackgroundRing count={background} />
    ) : mark === "question" ? (
      <Icon icon={BubbleChatIcon} tone={tone} size={15} strokeWidth={2} />
    ) : mark === "waiting" ? (
      <Icon icon={ShieldAlertIcon} tone={tone} size={15} strokeWidth={2} />
    ) : mark === "interrupted" ? (
      <Icon icon={Alert02Icon} tone={tone} size={15} strokeWidth={2} />
    ) : mark === "running" ? (
      <SpinnerRing size={14} tone={tone} />
    ) : (
      <View
        style={{
          width: mark === "idle" ? 6 : 8,
          height: mark === "idle" ? 6 : 8,
          borderRadius: 4,
          backgroundColor: mark === "idle" ? colors.idleDot : colors[tone],
        }}
      />
    );
  return (
    <View
      accessible={mark !== "idle"}
      accessibilityLabel={label || undefined}
      style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}
    >
      {body}
    </View>
  );
}

/** Desktop's background mark: a still accent ring around how many background agents still work. */
export function BackgroundRing({ count = 0, size = 15 }: { count?: number; size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.5,
        borderColor: colors.accent,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {count > 0 && (
        <Text allowFontScaling={false} style={{ color: colors.accent, fontSize: size * 0.55, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
          {count > 9 ? "9+" : count}
        </Text>
      )}
    </View>
  );
}

/** Desktop's pullRequestAction chip: the first blocker's fix, sent to the agent. */
export function PullRequestAction({ pr, onRun, disabled }: { pr: PullRequest; onRun: () => void; disabled?: boolean }) {
  const { colors } = useTheme();
  const blocker = pullRequestBlockers(pr)[0];
  if (!blocker) return null;
  const red = BLOCKERS[blocker].tone === "red";
  return (
    <StatusPill
      label={BLOCKERS[blocker].action}
      icon={GitPullRequestIcon}
      tone={red ? "red" : "orange"}
      tint={red ? colors.redTint : colors.orangeTint}
      disabled={disabled}
      onPress={onRun}
    />
  );
}

/** Desktop's SubagentTrack trigger: a chip with a ring while any agent works. */
export function SubagentChip({ agents, onPress }: { agents: Subagent[]; onPress: () => void }) {
  const count = agentCounts(agents);
  if (!count.total) return null;
  return (
    <StatusPill
      label="Subagents"
      count={count.total}
      leading={count.running > 0 ? <SpinnerRing size={11} /> : undefined}
      tone={count.failed ? "red" : "ink2"}
      accessibilityLabel={`Subagents, ${count.total}${count.running ? `, ${count.running} running` : ""}`}
      onPress={onPress}
    />
  );
}

import { Pressable, Text, View } from "react-native";
import { backgroundLabel } from "@milagre/shared/chat-activity";
import { BubbleChatIcon, GitMergeIcon, GitPullRequestIcon, ShieldAlertIcon, Alert02Icon } from "@hugeicons/core-free-icons";
import type { PullRequest, Subagent } from "@milagre/shared/model";
import { BLOCKERS, pullRequestBlockers, pullRequestPresentation } from "@milagre/shared/pr-blockers";
import { PR_ICONS } from "./pr-look";
import { chatMarkTone } from "@milagre/shared/chats";
import { agentCounts, MARK_LABEL, type ChatMark } from "./indicators";
import { Icon, SpinnerRing } from "./icons";
import { useTheme } from "./theme";
import { StatusPill } from "./status-pill";

/** Desktop's chat mark slot: a question bubble, an approval shield, a spinning ring, an unread dot, or a faint idle dot. */
export function ChatMarkIcon({ mark, background = 0 }: { mark: ChatMark; background?: number }) {
  const { colors } = useTheme();
  const tone = chatMarkTone(mark);
  const label = mark === "background" && background ? `${backgroundLabel(background)} running` : MARK_LABEL[mark];
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

/** Desktop's background mark: a still accent ring around how many background tasks still run. */
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

/** A PR ready to merge: the pill opens the PR sheet (the panel on an iPad), where the merge happens. */
export function PullRequestMerge({ pr, onOpen }: { pr: PullRequest; onOpen: () => void }) {
  const { colors } = useTheme();
  return <StatusPill label={`Merge #${pr.number}`} icon={GitMergeIcon} tone="green" tint={colors.greenTint} onPress={onOpen} />;
}

/** The PR's unresolved review threads: the pill opens them. */
export function PullRequestReview({ count, onOpen }: { count: number; onOpen: () => void }) {
  const { colors } = useTheme();
  return (
    <StatusPill
      label="Review"
      count={count}
      icon={BubbleChatIcon}
      tone="orange"
      tint={colors.orangeTint}
      accessibilityLabel={`Review, ${count} open ${count === 1 ? "thread" : "threads"}`}
      onPress={onOpen}
    />
  );
}

/** The Chat header's PR: its state and number, under the title; a tap opens the PR. */
export function HeaderPullRequestChip({ pr, onPress }: { pr: PullRequest; onPress: () => void }) {
  const { colors } = useTheme();
  const { tone, icon, spoken } = pullRequestPresentation(pr);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken.charAt(0).toUpperCase() + spoken.slice(1)}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 3, marginLeft: 2, opacity: pressed ? 0.55 : 1 })}
    >
      <Icon icon={PR_ICONS[icon]} tone={tone} size={11} strokeWidth={2} />
      <Text style={{ color: colors[tone], fontSize: 12, fontVariant: ["tabular-nums"] }}>#{pr.number}</Text>
    </Pressable>
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

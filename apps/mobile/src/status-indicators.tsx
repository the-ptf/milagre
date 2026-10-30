import { Pressable, Text, View } from "react-native";
import { backgroundLabel } from "@milagre/shared/chat-activity";
import {
  BubbleChatIcon,
  CircleDotIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ShieldAlertIcon,
  Alert02Icon,
  Link04Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { PullRequest, Subagent } from "@milagre/shared/model";
import { BLOCKERS, pullRequestBlockers, pullRequestPresentation } from "@milagre/shared/pr-blockers";
import { chatMarkPresentation } from "@milagre/shared/chats";
import { agentCounts, MARK_LABEL, type ChatMark } from "./indicators";
import { Icon, SpinnerRing } from "./icons";
import { lineHeight, radius, type } from "./design-tokens";
import { useTheme } from "./theme";
import { pressStyle } from "./ui";
import { StatusPill } from "./status-pill";

const MARK_ICONS = { bubble: BubbleChatIcon, "shield-alert": ShieldAlertIcon, link: Link04Icon, alert: Alert02Icon } as const;

/** Desktop's chat mark slot (chatMarkPresentation): an asking icon, a spinning ring, the background ring, an 8pt unread
 * or failed dot, or a solid 6pt ink4 idle dot. */
export function ChatMarkIcon({ mark, background = 0 }: { mark: ChatMark; background?: number }) {
  const { colors } = useTheme();
  const { icon, tone } = chatMarkPresentation(mark);
  const label = mark === "background" && background ? `${backgroundLabel(background)} running` : MARK_LABEL[mark];
  const body =
    icon === "ring" ? (
      <BackgroundRing count={background} />
    ) : icon === "spinner" ? (
      <SpinnerRing size={16} tone={tone} />
    ) : icon === "dot" ? (
      <View style={{ width: mark === "idle" ? 6 : 8, height: mark === "idle" ? 6 : 8, borderRadius: radius.full, backgroundColor: colors[tone] }} />
    ) : (
      <Icon icon={MARK_ICONS[icon]} tone={tone} size={16} />
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

/** Desktop's background mark: a still accent ring around how many background tasks still run, its count in caption2
 * accentInk. It grows with the text size (to 1.3x), past the 20pt slot if it must. */
export function BackgroundRing({ count = 0 }: { count?: number }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        minWidth: 20,
        minHeight: 20,
        paddingHorizontal: 2,
        borderRadius: radius.full,
        borderWidth: 1.5,
        borderColor: colors.accent,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {count > 0 && (
        <Text
          maxFontSizeMultiplier={1.3}
          style={{ color: colors.accentInk, fontSize: type.caption2, lineHeight: lineHeight.caption2, fontWeight: "600", fontVariant: ["tabular-nums"] }}
        >
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

const PR_ICONS = { merged: GitMergeIcon, ready: Tick02Icon, checking: CircleDotIcon, open: GitPullRequestIcon };

/** The Chat header's PR: its state and number, under the title; a tap opens the PR. */
export function HeaderPullRequestChip({ pr, onPress }: { pr: PullRequest; onPress: () => void }) {
  const { colors } = useTheme();
  const { tone, icon, label } = pullRequestPresentation(pr);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Pull request #${pr.number}${label ? `, ${label.toLowerCase()}` : ""}`}
      hitSlop={{ top: 14, bottom: 14, left: 6, right: 6 }}
      onPress={onPress}
      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 4, marginLeft: 2 }, pressStyle({ pressed })]}
    >
      <Icon icon={PR_ICONS[icon]} tone={tone} size={12} />
      <Text style={{ color: colors[`${tone}Ink`], fontSize: type.caption1, lineHeight: lineHeight.caption1, fontVariant: ["tabular-nums"] }}>#{pr.number}</Text>
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
      leading={count.running > 0 ? <SpinnerRing size={12} /> : undefined}
      tone={count.failed ? "red" : "ink2"}
      accessibilityLabel={`Subagents, ${count.total}${count.running ? `, ${count.running} running` : ""}`}
      onPress={onPress}
    />
  );
}

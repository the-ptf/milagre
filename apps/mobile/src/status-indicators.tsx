import { Pressable, Text, View } from "react-native";
import { backgroundLabel } from "@milagre/shared/chat-activity";
import { BubbleChatIcon, GitMergeIcon, GitPullRequestIcon, ShieldAlertIcon, Alert02Icon, Link04Icon } from "@hugeicons/core-free-icons";

import type { PullRequest, Subagent } from "@milagre/shared/model";
import { PR_TONE, BLOCKERS, pullRequestBlockers, pullRequestPresentation } from "@milagre/shared/pr-blockers";
import { PR_ICONS } from "./pr-look";
import { chatMarkPresentation } from "@milagre/shared/chats";
import { agentCounts, MARK_LABEL, type ChatMark } from "./indicators";
import { Icon, SpinnerRing } from "./icons";
import { lineHeight, radius, type } from "./design-tokens";
import { useTheme } from "./theme";
import { pressStyle } from "./ui";
import { StatusPill } from "./status-pill";

const MARK_ICONS = { bubble: BubbleChatIcon, "shield-alert": ShieldAlertIcon, link: Link04Icon, alert: Alert02Icon } as const;

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

export function HeaderPullRequestChip({ pr, onPress }: { pr: PullRequest; onPress: () => void }) {
  const { colors } = useTheme();
  const { tone, icon, spoken } = pullRequestPresentation(pr);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken.charAt(0).toUpperCase() + spoken.slice(1)}
      hitSlop={{ top: 14, bottom: 14, left: 6, right: 6 }}
      onPress={onPress}
      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 4, marginLeft: 2 }, pressStyle({ pressed })]}
    >
      <Icon icon={PR_ICONS[icon]} tone={tone} size={12} />
      <Text style={{ color: colors[PR_TONE[tone].label], fontSize: type.caption1, lineHeight: lineHeight.caption1, fontVariant: ["tabular-nums"] }}>
        #{pr.number}
      </Text>
    </Pressable>
  );
}

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

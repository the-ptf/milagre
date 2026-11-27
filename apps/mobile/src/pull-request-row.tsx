import { findingsLabel, type ReviewCounts } from "@milagre/shared/pr-review";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  Loading03Icon,
  Message01Icon,
} from "@hugeicons/core-free-icons";
import { pullRequestChecksLabel, pullRequestReviewBadge, type PullRequestRow } from "@milagre/shared/pull-request-list";
import { Icon, type IconData, type Tone } from "./icons";
import { Mascot } from "./mascot";
import { ago } from "./pr-review";
import { lineHeight, radius, space, type } from "./design-tokens";
import { useTheme } from "./theme";
import { DISABLED_OPACITY, Tag, pressStyle, tap, useStyles } from "./ui";

const CHECKS: Record<string, { icon: IconData; tone: Tone; word: string }> = {
  pass: { icon: CheckmarkCircle02Icon, tone: "greenInk", word: "passed" },
  fail: { icon: CancelCircleIcon, tone: "redInk", word: "failing" },
  running: { icon: Loading03Icon, tone: "orangeInk", word: "running" },
};

function stateIcon(row: PullRequestRow): { icon: IconData; tone: Tone } {
  if (row.state === "MERGED") return { icon: GitMergeIcon, tone: "purpleInk" };
  if (row.state === "CLOSED") return { icon: GitPullRequestClosedIcon, tone: "redInk" };
  if (row.isDraft) return { icon: GitPullRequestDraftIcon, tone: "ink3" };
  return { icon: GitPullRequestIcon, tone: "green" };
}

const repoName = (repo: string) => repo.slice(repo.lastIndexOf("/") + 1) || repo;

export type ReviewForMe = { color: string; reviewing: boolean; onPress: () => void } | null;

/** One PR on the Pull requests page: title, where it is and who opened it, then checks, review and the Chat that opened it. */
export function PullRequestRowView({
  row,
  findings,
  now,
  computer,
  review,
  onOpen,
}: {
  row: PullRequestRow;
  findings?: ReviewCounts;
  now: number;
  computer: string;
  review: ReviewForMe;
  onOpen: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const state = stateIcon(row);
  const checks = CHECKS[row.checks.state];
  const checksLabel = pullRequestChecksLabel(row.checks);
  const badge = pullRequestReviewBadge(row);
  const chat = row.chats[0];
  const when = ago(row.updatedAt, now);
  const author = row.author?.login ?? "";
  const where = `${repoName(row.repo)} #${row.number}${author ? ` · ${author}` : ""}${row.offline ? ` · ${computer}, offline` : ""}`;
  const label = [
    row.title,
    `${row.repo} #${row.number}${author ? ` by ${author}` : ""}`,
    row.offline ? `${computer}, offline` : "",
    checks && checksLabel ? `Checks ${checks.word}, ${checksLabel}` : "",
    review ? (review.reviewing ? "Orchestrator reviewing" : "") : badge.label,
    findings?.open ? findingsLabel(findings.open) : "",
    chat ? `Chat ${chat.title}` : "",
    when ? `Updated ${when === "now" ? "just now" : `${when} ago`}` : "",
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        tap();
        onOpen();
      }}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "flex-start", gap: space.lg, paddingVertical: space.lg },
        row.offline && { opacity: DISABLED_OPACITY.row },
        pressStyle({ pressed }),
      ]}
    >
      <View style={{ paddingTop: space.xxs }}>
        <Icon icon={state.icon} tone={state.tone} size={18} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: space.xxs }}>
        <Text numberOfLines={2} style={[styles.text, { fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "500" }]}>
          {row.title}
        </Text>
        <Text numberOfLines={1} style={styles.footnote}>
          {where}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, marginTop: space.xs, minHeight: 24 }}>
          {checks && checksLabel ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xxs, flexShrink: 0 }}>
              <Icon icon={checks.icon} tone={checks.tone} size={12} strokeWidth={2} />
              <Text style={{ color: colors[checks.tone], fontSize: type.caption1, lineHeight: lineHeight.caption1, fontWeight: "600" }}>{checksLabel}</Text>
            </View>
          ) : null}
          {review ? <ReviewButton {...review} /> : <Tag label={badge.label} tone={badge.tone} square style={{ flexShrink: 0 }} />}
          {findings?.open ? <Text style={[styles.caption, { color: findings.high ? colors.redInk : colors.ink2 }]}>{findingsLabel(findings.open)}</Text> : null}
          {chat ? (
            <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.xs }}>
              <Icon icon={Message01Icon} tone="ink3" size={12} />
              <Text numberOfLines={1} style={[styles.caption, { flexShrink: 1 }]}>
                {chat.title}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      {when ? <Text style={[styles.footnote, { paddingTop: space.xxs }]}>{when}</Text> : null}
    </Pressable>
  );
}

export function ReviewButton({ color, reviewing, onPress }: { color: string; reviewing: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const shape = {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: 28,
    borderRadius: radius.full,
    borderCurve: "continuous",
    flexShrink: 0,
  } as const;
  if (reviewing)
    return (
      <View accessible accessibilityLabel="Orchestrator reviewing" style={[shape, { paddingHorizontal: space.md, backgroundColor: colors.field }]}>
        <ActivityIndicator size="small" color={colors.ink3} />
        <Text style={{ color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "600" }}>Orchestrator reviewing</Text>
      </View>
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Review for me"
      accessibilityHint="Sends this pull request to the Orchestrator to review"
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={onPress}
      style={({ pressed }) => [
        shape,
        { paddingLeft: space.xs, paddingRight: space.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
        pressStyle({ pressed }),
      ]}
    >
      <Mascot size={20} color={color || undefined} mood="happy" />
      <Text style={{ color: colors.ink, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "600" }}>Review for me</Text>
    </Pressable>
  );
}

/** Rows' shapes while the first answer is on its way. */
export function PullRequestRowSkeleton() {
  const { colors } = useTheme();
  const bar = (width: number | `${number}%`, height: number) => ({ width, height, borderRadius: radius.chip, backgroundColor: colors.field });
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: "row", gap: space.lg, paddingVertical: space.lg }}
    >
      <View style={[bar(18, 18), { borderRadius: radius.full }]} />
      <View style={{ flex: 1, gap: space.sm }}>
        <View style={bar("85%", 14)} />
        <View style={bar("50%", 12)} />
        <View style={bar("35%", 12)} />
      </View>
    </View>
  );
}

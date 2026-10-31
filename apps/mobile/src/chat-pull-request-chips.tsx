import { Pressable, Text, View } from "react-native";
import type { ReactNode } from "react";
import * as Linking from "expo-linking";
import type { PullRequest } from "@milagre/shared/model";
import { pullRequestPresentation, rowPullRequests } from "@milagre/shared/pr-blockers";
import { issueChipLabel, type LinearIssue } from "@milagre/shared/linear";
import { Icon, LinearLogo } from "./icons";
import { PullDown } from "./ui";
import { useTheme } from "./theme";
import { PR_ICONS } from "./pr-look";

/** PR chips a row shows; the rest are a count, as on desktop. */
const ROW_PR_LIMIT = 1;

/**
 * Desktop's PR chip and overflow menu: the first pull request, then "+3" for the rest, with tap targets separate from the
 * Chat title. The Worktree's Linear issue comes first. A PR chip opens the PR in its Chat when the row can (the PR sheet),
 * else on GitHub.
 */
export function ChatPullRequestChips({
  pullRequests,
  linearIssue,
  children,
  onOpenPullRequest,
}: {
  pullRequests: PullRequest[];
  linearIssue?: LinearIssue;
  children?: ReactNode;
  /** Opens the PR in its Chat (the PR sheet); without it a PR opens on GitHub. */
  onOpenPullRequest?: (pr: PullRequest) => void;
}) {
  const { colors } = useTheme();
  if (!pullRequests.length && !linearIssue) return null;
  const ordered = rowPullRequests(pullRequests);
  const open = (url: string) => {
    if (url.startsWith("https://")) void Linking.openURL(url).catch(() => {});
  };
  const openPr = (pr: PullRequest) => (onOpenPullRequest ? onOpenPullRequest(pr) : open(pr.url));
  return (
    <View style={{ flexDirection: "row", alignItems: "center", columnGap: 8, paddingLeft: 42, paddingRight: 4 }}>
      {linearIssue && (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open Linear issue ${linearIssue.key}`}
          accessibilityHint={linearIssue.title}
          hitSlop={{ top: 10, bottom: 10 }}
          onPress={(event) => {
            event.stopPropagation();
            open(linearIssue.url);
          }}
          style={({ pressed }) => ({ minHeight: 24, flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 5, opacity: pressed ? 0.55 : 1 })}
        >
          <LinearLogo size={11} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink2, fontSize: 12 }}>
            {issueChipLabel(linearIssue)}
          </Text>
        </Pressable>
      )}
      {ordered.slice(0, ROW_PR_LIMIT).map((pr) => {
        const { tone, icon, label, spoken } = pullRequestPresentation(pr);
        return (
          <Pressable
            key={pr.url}
            accessibilityRole={onOpenPullRequest ? "button" : "link"}
            accessibilityLabel={`Open ${spoken}`}
            accessibilityHint={pr.title}
            hitSlop={{ top: 10, bottom: 10 }}
            onPress={(event) => {
              event.stopPropagation();
              openPr(pr);
            }}
            style={({ pressed }) => ({ minHeight: 24, flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 4, opacity: pressed ? 0.55 : 1 })}
          >
            <Icon icon={PR_ICONS[icon]} tone={tone} size={12} />
            <Text style={{ color: colors.ink2, fontSize: 12, fontVariant: ["tabular-nums"] }}>#{pr.number}</Text>
            {pullRequests.length === 1 && !!label && (
              <Text numberOfLines={1} style={{ flexShrink: 1, color: colors[tone], fontSize: 12 }}>
                {label}
              </Text>
            )}
          </Pressable>
        );
      })}
      {ordered.length > ROW_PR_LIMIT && (
        <PullDown
          label={`${ordered.length - ROW_PR_LIMIT} more pull request${ordered.length - ROW_PR_LIMIT === 1 ? "" : "s"}`}
          title="Pull requests"
          sections={[{ items: ordered.map((pr) => ({ id: pr.url, title: `#${pr.number} · ${pr.title}` })) }]}
          onSelect={(url) => {
            const pr = ordered.find((entry) => entry.url === url);
            if (pr) openPr(pr);
          }}
        >
          <View style={{ minHeight: 24, justifyContent: "center" }}>
            <Text style={{ color: colors.ink2, fontSize: 12 }}>+{ordered.length - ROW_PR_LIMIT}</Text>
          </View>
        </PullDown>
      )}
      {children}
    </View>
  );
}

/**
 * The same links inline in a Chat row's second line (the One list): the Linear key, then the first pull request and a count
 * of the rest, each link its own tap target so a tap opens the issue or pull request rather than the Chat. `separator` goes
 * between them.
 */
export function InlinePullRequestLinks({
  pullRequests,
  linearIssue,
  separator,
  fontSize = 14,
  onOpenPullRequest,
}: {
  pullRequests: PullRequest[];
  linearIssue?: LinearIssue;
  separator: ReactNode;
  fontSize?: number;
  onOpenPullRequest?: (pr: PullRequest) => void;
}) {
  const { colors } = useTheme();
  const open = (url: string) => {
    if (url.startsWith("https://")) void Linking.openURL(url).catch(() => {});
  };
  const openPr = (pr: PullRequest) => (onOpenPullRequest ? onOpenPullRequest(pr) : open(pr.url));
  const ordered = rowPullRequests(pullRequests);
  const links: ReactNode[] = [];
  if (linearIssue)
    links.push(
      <Pressable
        key="linear"
        accessibilityRole="link"
        accessibilityLabel={`Open Linear issue ${linearIssue.key}`}
        accessibilityHint={linearIssue.title}
        hitSlop={8}
        onPress={(event) => {
          event.stopPropagation();
          open(linearIssue.url);
        }}
        style={({ pressed }) => ({ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 4, opacity: pressed ? 0.55 : 1 })}
      >
        <LinearLogo size={fontSize - 3} />
        <Text style={{ color: colors.ink2, fontSize }}>{linearIssue.key}</Text>
      </Pressable>,
    );
  for (const pr of ordered.slice(0, ROW_PR_LIMIT)) {
    const { tone, icon, spoken } = pullRequestPresentation(pr);
    links.push(
      <Pressable
        key={pr.url}
        accessibilityRole={onOpenPullRequest ? "button" : "link"}
        accessibilityLabel={`Open ${spoken}`}
        accessibilityHint={pr.title}
        hitSlop={8}
        onPress={(event) => {
          event.stopPropagation();
          openPr(pr);
        }}
        style={({ pressed }) => ({ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 3, opacity: pressed ? 0.55 : 1 })}
      >
        <Icon icon={PR_ICONS[icon]} tone={tone} size={fontSize - 1} />
        <Text style={{ color: colors.ink2, fontSize, fontVariant: ["tabular-nums"] }}>#{pr.number}</Text>
      </Pressable>,
    );
  }
  if (ordered.length > ROW_PR_LIMIT)
    links.push(
      <Text key="more" style={{ color: colors.ink3, fontSize }}>
        +{ordered.length - ROW_PR_LIMIT}
      </Text>,
    );
  return links.flatMap((link, index) => (index ? [<View key={`sep${index}`}>{separator}</View>, link] : [link]));
}

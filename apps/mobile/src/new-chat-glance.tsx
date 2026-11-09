import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { GitPullRequestDraftIcon, GitPullRequestIcon } from "@hugeicons/core-free-icons";
import type { ProviderUsage, UsageSnapshot } from "@milagre/shared/model";
import {
  GLANCE_PR_LIMIT,
  glanceToday,
  hourShares,
  openPullRequestRows,
  todayKey,
  type GlancePrTone,
  type GlancePullRequest,
  type GlanceToday,
  type OpenPullRequest,
} from "@milagre/shared/new-chat-glance";
import { TOKEN_USAGE_PROVIDER_COLORS, formatTokenCount, formatUsd, type TokenUsageReport } from "@milagre/shared/token-usage";
import { PROVIDER_NAMES, formatPercent, formatResetsIn, shownPercent, usageTone, visibleProviders, type UsageDisplay } from "@milagre/shared/usage";
import { useAccountUsage } from "@milagre/shared/use-account-usage";
import type { Client } from "./client";
import { radius, type } from "./design-tokens";
import { Icon, ProviderLogo } from "./icons";
import { useTheme, type Palette } from "./theme";
import { useUsageDisplay } from "./usage-display-setting";

const PR_REFRESH_MS = 60_000;
const BAR_HEIGHT = 32;
const NO_ROWS: GlancePullRequest[] = [];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const PR_TONE: Record<GlancePrTone, "green" | "orange" | "red" | "purple" | "ink3"> = {
  green: "green",
  orange: "orange",
  red: "red",
  purple: "purple",
  muted: "ink3",
};

// The repository's open PRs (the host reads gh at most once a minute), again each minute and when the app returns.
// A host without the command throws "Unknown command": the card stays away.
function useOpenPullRequests(client: Client | null, projectPath: string | null) {
  const [found, setFound] = useState<{ client: Client | null; projectPath: string | null; rows: GlancePullRequest[] }>({
    client: null,
    projectPath: null,
    rows: [],
  });
  useEffect(() => {
    if (!client || !projectPath) return;
    let live = true;
    const load = () =>
      client
        .call<OpenPullRequest[]>("pull-requests:open", [projectPath])
        .then((list) => (live ? setFound({ client, projectPath, rows: openPullRequestRows(list) }) : undefined))
        .catch(() => {});
    void load();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void load();
    }, PR_REFRESH_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => {
      live = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [client, projectPath]);
  // Rows read for another Project or computer are not this one's.
  return found.client === client && found.projectPath === projectPath ? found.rows : NO_ROWS;
}

// Plan usage from the saved numbers (the hook refreshes them when stale), scoped to the Project like desktop.
function useScopedUsage(client: Client | null, scopeKey: string): UsageSnapshot | null {
  const source = useMemo(() => {
    if (!client) return null;
    return {
      read: () => client.call<UsageSnapshot>("usage:read", [scopeKey]),
      cached: () => client.call<UsageSnapshot>("usage:cached", [scopeKey]),
      isActive: () => AppState.currentState === "active",
      subscribe: (usageChanged: () => void, accountsChanged: () => void) => {
        const socket = client.live("", {
          onSignal: (signal) => {
            if (signal === "usage") usageChanged();
            if (signal === "accounts") accountsChanged();
          },
          onStatus: (open) => {
            if (open) usageChanged();
          },
        });
        return () => socket.close();
      },
    };
  }, [client, scopeKey]);
  return useAccountUsage(source).snapshot;
}

// Today's tokens on the computer, read by the hour; the host's token-usage signal reads again.
function useToday(client: Client | null) {
  const [today, setToday] = useState<GlanceToday | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const read = () => {
      const day = todayKey();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      client
        .call<TokenUsageReport>("token-usage:read", [{ range: "24h", timeZone, days: { from: day, to: day } }])
        .then((report) => (live ? setToday(glanceToday(report)) : undefined))
        .catch(() => {});
    };
    read();
    const socket = client.live("", {
      onSignal: (signal) => {
        if (signal === "token-usage") read();
      },
      onStatus: () => {},
    });
    return () => {
      live = false;
      socket.close();
    };
  }, [client]);
  return today;
}

function Card({ title, count, aside, children }: { title: string; count?: number; aside?: string | null; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLabel={title}
      style={{
        gap: 12,
        padding: 16,
        borderRadius: radius.card,
        borderCurve: "continuous",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        // The composer tray's fill (offline-tray.tsx), as on desktop.
        backgroundColor: colors.inset,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <Text accessibilityRole="header" style={{ color: colors.ink2, fontSize: type.caption1, fontWeight: "600" }}>
          {title}
          {count !== undefined ? <Text style={{ color: colors.ink3, fontWeight: "400", fontVariant: ["tabular-nums"] }}>{`  ${count}`}</Text> : null}
        </Text>
        {aside ? (
          <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.caption2, flexShrink: 1, fontVariant: ["tabular-nums"] }}>
            {aside}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function PullRequestRow({ pr }: { pr: GlancePullRequest }) {
  const { colors } = useTheme();
  // The PR sheet needs a Worktree and a Chat this draft doesn't have yet, so the PR opens on GitHub.
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Pull request ${pr.number}, ${pr.title}, ${pr.status}${pr.age ? `, updated ${pr.age} ago` : ""}`}
      accessibilityHint="Opens the pull request"
      onPress={() => void Linking.openURL(pr.url).catch(() => {})}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        marginHorizontal: -8,
        paddingHorizontal: 8,
        borderRadius: radius.control,
        borderCurve: "continuous",
        backgroundColor: pressed ? colors.hover : "transparent",
      })}
    >
      <Icon icon={pr.draft ? GitPullRequestDraftIcon : GitPullRequestIcon} size={16} tone={PR_TONE[pr.tone]} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.footnote, fontWeight: "500" }}>
          {pr.title}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.caption2 }}>
          #{pr.number} · {pr.status}
        </Text>
      </View>
      {pr.age ? <Text style={{ color: colors.ink3, fontSize: type.caption2, fontVariant: ["tabular-nums"] }}>{pr.age}</Text> : null}
    </Pressable>
  );
}

function PullRequestsCard({ rows }: { rows: GlancePullRequest[] }) {
  return (
    <Card title="Open pull requests" count={rows.length}>
      <View style={{ marginBottom: -4 }}>
        {rows.slice(0, GLANCE_PR_LIMIT).map((pr) => (
          <PullRequestRow key={pr.url} pr={pr} />
        ))}
      </View>
    </Card>
  );
}

function providerSummary(usage: ProviderUsage, display: UsageDisplay) {
  return usage.windows
    .slice(0, 2)
    .map((window) => `${formatPercent(shownPercent(window.usedPercent, display))} ${window.shortLabel}`)
    .join("  ·  ");
}

function barFill(colors: Palette, provider: ProviderUsage["provider"], peak: number) {
  const tone = usageTone(peak);
  return tone === "critical" ? colors.red : tone === "warning" ? colors.orange : (TOKEN_USAGE_PROVIDER_COLORS[provider] ?? colors.ink);
}

function UsageCard({ providers, display }: { providers: ProviderUsage[]; display: UsageDisplay }) {
  const { colors } = useTheme();
  const [now] = useState(Date.now);
  // The closest limit's reset: what decides whether to start something big now.
  const closest = providers
    .flatMap((usage) => usage.windows.map((window) => ({ provider: usage.provider, window })))
    .sort((a, b) => b.window.usedPercent - a.window.usedPercent)[0];
  const resets = closest ? formatResetsIn(closest.window.resetsAt, now) : null;
  return (
    <Card title="Plan usage" aside={resets && closest ? `${PROVIDER_NAMES[closest.provider]} · ${resets.toLowerCase()}` : null}>
      <View style={{ gap: 12 }}>
        {providers.map((usage) => {
          const peak = usage.windows.reduce((max, window) => Math.max(max, window.usedPercent), 0);
          const percent = Math.max(0, Math.min(100, shownPercent(peak, display)));
          const summary = usage.windows.length > 0 ? providerSummary(usage, display) : "—";
          return (
            <View key={usage.provider} accessible accessibilityLabel={`${PROVIDER_NAMES[usage.provider]} usage, ${summary}`} style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <ProviderLogo provider={usage.provider} size={16} />
                <Text style={{ flex: 1, color: colors.ink, fontSize: type.caption1, fontWeight: "500" }}>{PROVIDER_NAMES[usage.provider]}</Text>
                <Text style={{ color: colors.ink2, fontSize: type.caption2, fontVariant: ["tabular-nums"] }}>{summary}</Text>
              </View>
              <View style={{ height: 4, borderRadius: radius.full, overflow: "hidden", backgroundColor: colors.lineStrong }}>
                <View style={{ width: `${percent}%`, height: "100%", borderRadius: radius.full, backgroundColor: barFill(colors, usage.provider, peak) }} />
              </View>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

function TodayCard({ today }: { today: GlanceToday }) {
  const { colors } = useTheme();
  const shares = hourShares(today.hours);
  const stats = [
    { value: formatUsd(today.costUsd), label: "spent" },
    { value: formatTokenCount(today.tokens), label: "tokens" },
    { value: String(today.chats), label: today.chats === 1 ? "Chat" : "Chats" },
  ];
  return (
    <Card title="Today" aside="Token usage">
      <View accessible accessibilityLabel={`Today: ${stats.map((stat) => `${stat.value} ${stat.label}`).join(", ")}`} style={{ flexDirection: "row", gap: 12 }}>
        {stats.map((stat) => (
          <View key={stat.label} style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.title3, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
              {stat.value}
            </Text>
            <Text style={{ color: colors.ink3, fontSize: type.caption2 }}>{stat.label}</Text>
          </View>
        ))}
      </View>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ flexDirection: "row", alignItems: "flex-end", gap: 3, height: BAR_HEIGHT }}
      >
        {HOURS.map((hour) => {
          const share = shares[hour] ?? 0;
          return (
            <View
              key={hour}
              style={{
                flex: 1,
                borderRadius: radius.full,
                height: share > 0 ? Math.max(4, share * BAR_HEIGHT) : 3,
                backgroundColor: hour > today.currentHour || share === 0 ? colors.lineStrong : colors.accent,
                opacity: hour < today.currentHour && share > 0 ? 0.6 : 1,
              }}
            />
          );
        })}
      </View>
    </Card>
  );
}

/**
 * Under a new Chat's "Start building in" line: the repository's open PRs, plan usage and today's tokens. Each card shows
 * only with something in it; a Chats home draft (no `projectPath`) has no PRs. Nothing shows while there is nothing to show.
 */
export function NewChatGlance({ client, projectPath, scopeKey }: { client: Client | null; projectPath: string | null; scopeKey: string }) {
  const prs = useOpenPullRequests(client, projectPath);
  const snapshot = useScopedUsage(client, scopeKey);
  const today = useToday(client);
  const [display] = useUsageDisplay();
  const providers = snapshot ? visibleProviders(snapshot) : [];
  const showToday = today !== null && (today.costUsd > 0 || today.tokens > 0);
  if (prs.length === 0 && providers.length === 0 && !showToday) return null;
  return (
    <ScrollView
      style={{ alignSelf: "stretch", flexGrow: 0, flexShrink: 1, marginHorizontal: -8, marginTop: 16 }}
      contentContainerStyle={{ gap: 12, paddingHorizontal: 0 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {prs.length > 0 ? <PullRequestsCard rows={prs} /> : null}
      {providers.length > 0 ? <UsageCard providers={providers} display={display} /> : null}
      {showToday ? <TodayCard today={today} /> : null}
    </ScrollView>
  );
}

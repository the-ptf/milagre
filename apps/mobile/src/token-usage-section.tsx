import { useEffect, useMemo, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { ArrowDown01Icon, ArrowRight01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { mix } from "@milagre/shared/themes";
import { providerName } from "@milagre/shared/providers";
import {
  TOKEN_USAGE_PROVIDERS,
  TOKEN_USAGE_PROVIDER_COLORS,
  TOKEN_USAGE_RANGES,
  cacheHitRate,
  calendarDayLabel,
  calendarLevels,
  calendarSummary,
  calendarWeeks,
  chatMeta,
  coveredDays,
  formatMetric,
  formatShare,
  formatTokenCount,
  formatUsd,
  metricOf,
  periodLabel,
  splitValue,
  tokenTotal,
  type TokenUsageDays,
  type TokenUsageMetric,
  type TokenUsageProject,
  type TokenUsageRange,
  type TokenUsageReport,
} from "@milagre/shared/token-usage";
import type { ModelProvider } from "@milagre/shared/model";
import type { Client } from "./client";
import { Icon, SpinnerRing } from "./icons";
import { Segmented } from "./primitives/segmented";
import { ErrorNotice } from "./primitives/error-notice";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { useStyles } from "./ui";
import { radius, type } from "./design-tokens";

// While a scan runs, the screen reads again this often; the host's token-usage signal also reads at once.
const REFRESHING_POLL_MS = 2500;
const FIRST_CHATS = 3;
const GAP = 4;
const LEVEL_MIX = [0.2, 0.38, 0.56, 0.76, 1];

/** The connected computer's report for a range or picked days, read again when its host signals new numbers. */
function useTokenUsage(client: Client | null, range: TokenUsageRange, days: TokenUsageDays | null) {
  const [report, setReport] = useState<TokenUsageReport | null>(null);
  const [error, setError] = useState("");
  const from = days?.from;
  const to = days?.to;
  useEffect(() => {
    if (!client) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const read = async () => {
      clearTimeout(timer);
      try {
        const next = await client.call<TokenUsageReport>("token-usage:read", [{ range, timeZone, ...(from && to ? { days: { from, to } } : {}) }]);
        if (!live) return;
        setReport(next);
        setError("");
        if (next.refreshing) timer = setTimeout(() => void read(), REFRESHING_POLL_MS);
      } catch (failure) {
        if (live) setError(failure instanceof Error ? failure.message : "Could not read token usage.");
      }
    };
    void read();
    const socket = client.live("", {
      onSignal: (signal) => {
        if (signal === "token-usage") void read();
      },
      onStatus: () => {},
    });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void read();
    });
    return () => {
      live = false;
      clearTimeout(timer);
      socket.close();
      subscription.remove();
    };
  }, [client, range, from, to]);
  return { report, error };
}

function SplitBar({ values, whole, height }: { values: { provider: ModelProvider; value: number }[]; whole: number; height: number }) {
  const shown = values.filter((entry) => entry.value > 0);
  const used = shown.reduce((sum, entry) => sum + entry.value, 0);
  return (
    <View style={{ flexDirection: "row", gap: 2, height }}>
      {shown.map((entry) => (
        <View
          key={entry.provider}
          style={{ flex: entry.value, minWidth: 3, borderRadius: radius.full, backgroundColor: TOKEN_USAGE_PROVIDER_COLORS[entry.provider] }}
        />
      ))}
      {whole > used ? <View style={{ flex: whole - used }} /> : null}
    </View>
  );
}

function Calendar({ report, metric, onPick }: { report: TokenUsageReport; metric: TokenUsageMetric; onPick: (days: TokenUsageDays) => void }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const weeks = useMemo(() => calendarWeeks(report.calendar), [report.calendar]);
  const levels = useMemo(() => calendarLevels(report.calendar, metric), [report.calendar, metric]);
  const covered = useMemo(() => coveredDays(report), [report]);
  const summary = calendarSummary(report.calendar, metric);
  const shades = useMemo(() => [colors.hover2, ...LEVEL_MIX.map((share) => mix(colors.surface, colors.accent, share))], [colors]);
  const cell = weeks.length ? Math.floor((width - GAP * (weeks.length - 1)) / weeks.length) : 0;
  return (
    <View style={[styles.card, { gap: 10 }]}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Text style={{ color: colors.ink, fontSize: type.subheadline, fontWeight: "600" }}>Past 90 days</Text>
        <Text style={{ color: colors.ink2, fontSize: type.footnote, fontWeight: "500", fontVariant: ["tabular-nums"] }}>
          {formatMetric(metric, summary.total)}
        </Text>
      </View>
      <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ flexDirection: "row", gap: GAP }}>
        {cell > 0 &&
          weeks.map((week, column) => (
            <View key={column} style={{ gap: GAP }}>
              {week.days.map((day, row) =>
                day ? (
                  <Pressable
                    key={day.key}
                    accessibilityRole="button"
                    accessibilityLabel={`${calendarDayLabel(day)}: ${formatMetric(metric, metric === "cost" ? day.costUsd : day.tokens)}`}
                    accessibilityState={{ selected: Boolean(report.days && covered.has(day.key)) }}
                    hitSlop={2}
                    onPress={() => onPick({ from: day.key, to: day.key })}
                    style={{
                      width: cell,
                      height: cell,
                      borderRadius: radius.chip,
                      borderCurve: "continuous",
                      backgroundColor: shades[levels.get(day.key) ?? 0],
                      opacity: covered.has(day.key) ? 1 : 0.35,
                    }}
                  />
                ) : (
                  <View key={`empty-${row}`} style={{ width: cell, height: cell }} />
                ),
              )}
            </View>
          ))}
      </View>
      <Text style={styles.caption}>
        {summary.active} active {summary.active === 1 ? "day" : "days"}
        {summary.busiest ? ` · busiest ${summary.busiest.label} (${formatMetric(metric, summary.busiest.value)})` : ""}. Tap a day to see only it.
      </Text>
    </View>
  );
}

function ProjectRows({
  project,
  metric,
  largest,
  now,
  open,
  onToggle,
  onOpenChat,
}: {
  project: TokenUsageProject;
  metric: TokenUsageMetric;
  largest: number;
  now: number;
  open: boolean;
  onToggle: () => void;
  onOpenChat: (projectPath: string, sessionId: number) => void;
}) {
  const { colors } = useTheme();
  const [all, setAll] = useState(false);
  const value = metricOf(metric, project.totals);
  const chats = all ? project.chats : project.chats.slice(0, FIRST_CHATS);
  const hidden = project.chats.length - chats.length;
  const name = project.milagre ? project.name : `${project.name} · ${project.count} ${project.count === 1 ? "folder" : "folders"}`;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${name}, ${formatMetric(metric, value)}`}
        onPress={onToggle}
        style={({ pressed }) => ({ paddingHorizontal: 16, paddingVertical: 14, gap: 8, opacity: pressed ? 0.6 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            numberOfLines={1}
            style={{ flex: 1, color: project.milagre ? colors.ink : colors.ink2, fontSize: type.body, fontWeight: project.milagre ? "600" : "500" }}
          >
            {name}
          </Text>
          <Text style={{ color: colors.ink, fontSize: type.body, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{formatMetric(metric, value)}</Text>
          <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={16} tone="ink4" />
        </View>
        <View style={{ width: `${Math.max(2, (value / Math.max(largest, 1)) * 100)}%` }}>
          <SplitBar
            values={TOKEN_USAGE_PROVIDERS.map((provider) => ({ provider, value: splitValue(metric, project.providers, provider) }))}
            whole={value}
            height={6}
          />
        </View>
      </Pressable>
      {open
        ? chats.map((chat, index) => {
            const canOpen = chat.kind === "chat" && chat.sessionId !== undefined;
            const body = (
              <>
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: radius.full,
                    backgroundColor: chat.providers[0] ? TOKEN_USAGE_PROVIDER_COLORS[chat.providers[0]] : colors.ink4,
                  }}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text numberOfLines={1} style={{ color: chat.kind === "chat" ? colors.ink : colors.ink2, fontSize: type.callout }}>
                    {chat.title}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.footnote }}>
                    {chatMeta(chat, now)}
                  </Text>
                </View>
                <Text style={{ color: colors.ink, fontSize: type.subheadline, fontVariant: ["tabular-nums"] }}>
                  {formatMetric(metric, metricOf(metric, chat.totals))}
                </Text>
              </>
            );
            const row = { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, minHeight: 56, paddingLeft: 22, paddingRight: 16 };
            return canOpen ? (
              <Pressable
                key={chat.sessionId}
                accessibilityRole="button"
                onPress={() => onOpenChat(project.path, chat.sessionId!)}
                style={({ pressed }) => [row, { opacity: pressed ? 0.6 : 1 }]}
              >
                {body}
              </Pressable>
            ) : (
              <View key={`${chat.kind}-${index}`} style={row}>
                {body}
              </View>
            );
          })
        : null}
      {open && hidden > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setAll(true)}
          style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", paddingLeft: 38, opacity: pressed ? 0.6 : 1 })}
        >
          <Text style={{ color: colors.accentInk, fontSize: type.subheadline, fontWeight: "500" }}>
            Show {hidden} more {project.milagre ? (hidden === 1 ? "Chat" : "Chats") : hidden === 1 ? "folder" : "folders"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Token usage on the connected computer, as on the desktop's Usage page: the total and its provider split, the last 90
 * days as a calendar whose days pick what the screen covers, then where it went (Projects and Chats) and the models.
 */
export function TokenUsageSection() {
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const client = session.client;
  const [range, setRange] = useState<TokenUsageRange>("7d");
  const [metric, setMetric] = useState<TokenUsageMetric>("cost");
  const [days, setDays] = useState<TokenUsageDays | null>(null);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const { report, error } = useTokenUsage(client, range, days);
  const now = report?.generatedAt ?? 0;
  if (!client) return <Text style={styles.muted}>Connect to a computer to see its token usage.</Text>;
  const openChat = (projectPath: string, sessionId: number) => {
    router.dismissAll();
    router.replace({ pathname: "/chat", params: { id: String(sessionId), projectPath, hostId: client.url } });
  };
  const providers = report ? TOKEN_USAGE_PROVIDERS.filter((provider) => report.providers.some((entry) => entry.provider === provider)) : [];
  const whole = report ? metricOf(metric, report.totals) : 0;
  const largest = report ? Math.max(0, ...report.projects.map((project) => metricOf(metric, project.totals))) : 0;
  return (
    <View style={{ gap: 16 }}>
      <Segmented
        label="Period"
        value={days ? "" : range}
        options={TOKEN_USAGE_RANGES.map((option) => ({ value: option.value, title: option.short }))}
        onChange={(value) => {
          setDays(null);
          setRange(value as TokenUsageRange);
        }}
      />
      <Segmented
        label="Show"
        value={metric}
        options={[
          { value: "cost", title: "Cost" },
          { value: "tokens", title: "Tokens" },
        ]}
        onChange={(value) => setMetric(value as TokenUsageMetric)}
      />
      {error ? <ErrorNotice message={error} /> : null}
      {!report && !error ? (
        <View style={[styles.row, { gap: 10 }]}>
          <SpinnerRing size={18} />
          <Text style={styles.muted}>Loading usage…</Text>
        </View>
      ) : null}
      {report?.refreshing ? (
        <View style={[styles.row, { gap: 8 }]}>
          <SpinnerRing size={14} />
          <Text style={styles.caption}>
            {report.firstScan ? "Reading the Claude Code and Codex transcripts for the first time…" : "Reading new transcripts…"}
          </Text>
        </View>
      ) : null}
      {report ? (
        <>
          <View style={[styles.card, { gap: 6 }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: colors.ink3, fontSize: type.footnote }}>{periodLabel(report)} · at API prices</Text>
              {days ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear the picked day"
                  hitSlop={12}
                  onPress={() => setDays(null)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingHorizontal: 8,
                    height: 24,
                    borderRadius: radius.full,
                    backgroundColor: colors.hover,
                  }}
                >
                  <Text style={{ color: colors.ink2, fontSize: type.caption1, fontWeight: "500" }}>Clear</Text>
                  <Icon icon={Cancel01Icon} size={12} tone="ink2" />
                </Pressable>
              ) : null}
            </View>
            <Text selectable style={{ color: colors.ink, fontSize: type.largeTitle, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
              {formatMetric(metric, whole)}
            </Text>
            <Text style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: 20 }}>
              {metric === "cost" ? `${formatTokenCount(tokenTotal(report.totals))} tokens` : formatUsd(report.totals.costUsd)} ·{" "}
              {formatTokenCount(report.totals.requests)} requests
              {tokenTotal(report.totals) > 0
                ? ` · ${Math.round(cacheHitRate(report.totals) * 100)}% from cache, about ${formatUsd(report.totals.cacheSavingsUsd)} saved`
                : ""}
            </Text>
            {providers.length ? (
              <View style={{ gap: 8, marginTop: 6 }}>
                <SplitBar
                  values={providers.map((provider) => ({
                    provider,
                    value: metricOf(metric, report.providers.find((entry) => entry.provider === provider)!.totals),
                  }))}
                  whole={whole}
                  height={8}
                />
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  {providers.map((provider) => {
                    const entry = report.providers.find((item) => item.provider === provider)!;
                    return (
                      <View key={provider} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: TOKEN_USAGE_PROVIDER_COLORS[provider] }} />
                        <Text style={{ color: colors.ink2, fontSize: type.footnote, fontVariant: ["tabular-nums"] }}>
                          {providerName(provider)} {formatMetric(metric, metricOf(metric, entry.totals))} · {formatShare(metricOf(metric, entry.totals), whole)}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </View>
          <Calendar report={report} metric={metric} onPick={setDays} />
          <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type.title3, fontWeight: "600", marginTop: 8 }}>
            Where it went
          </Text>
          {report.projects.length ? (
            <View style={[styles.card, { padding: 0, gap: 0 }]}>
              {report.projects.map((project, index) => {
                const key = project.path || "outside";
                const open = toggled[key] ?? index === 0;
                return (
                  <View key={key}>
                    {index > 0 ? <View style={[styles.separator, { marginLeft: 16 }]} /> : null}
                    <ProjectRows
                      project={project}
                      metric={metric}
                      largest={largest}
                      now={now}
                      open={open}
                      onToggle={() => setToggled((current) => ({ ...current, [key]: !open }))}
                      onOpenChat={openChat}
                    />
                  </View>
                );
              })}
            </View>
          ) : (
            <Text style={styles.muted}>No usage in this period.</Text>
          )}
          {report.models.length ? (
            <>
              <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type.title3, fontWeight: "600", marginTop: 8 }}>
                Models
              </Text>
              <View style={[styles.card, { padding: 0, gap: 0 }]}>
                {report.models.map((model, index) => (
                  <View key={`${model.provider}:${model.model}`}>
                    {index > 0 ? <View style={[styles.separator, { marginLeft: 16 }]} /> : null}
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, paddingHorizontal: 16 }}>
                      <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: TOKEN_USAGE_PROVIDER_COLORS[model.provider] }} />
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.callout }}>
                          {model.model}
                        </Text>
                        <Text style={{ color: colors.ink3, fontSize: type.footnote }}>
                          {formatTokenCount(tokenTotal(model.totals))} tokens · {Math.round(cacheHitRate(model.totals) * 100)}% cached
                        </Text>
                      </View>
                      <Text
                        style={{
                          color: model.priced || metric === "tokens" ? colors.ink : colors.ink3,
                          fontSize: type.subheadline,
                          fontWeight: "500",
                          fontVariant: ["tabular-nums"],
                        }}
                      >
                        {metric === "cost" && !model.priced ? "Unpriced" : formatMetric(metric, metricOf(metric, model.totals))}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            </>
          ) : null}
          <Text style={[styles.caption, { lineHeight: 17 }]}>
            {
              "Read from the Claude Code and Codex transcripts on this computer, including sessions run outside Milagre. Costs are estimates at API prices from LiteLLM's model list, not your plan's bill. Kiro and Antigravity aren't counted."
            }
          </Text>
        </>
      ) : null}
    </View>
  );
}

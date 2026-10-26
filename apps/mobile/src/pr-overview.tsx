import React, { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  Copy01Icon,
  FileDiffIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  LinkSquare02Icon,
  Loading03Icon,
  MessageAdd01Icon,
  MoreHorizontalIcon,
  SparklesIcon,
  Tick02Icon,
  BubbleChatIcon,
} from "@hugeicons/core-free-icons";
import {
  canMergeNow,
  checksOutcome,
  checksSummary,
  mergeStatus,
  type MergeMethod,
  type MergeStatus,
  type PullRequestDetail,
} from "@milagre/shared/pull-request-review";
import type { Client } from "./client";
import { Icon, type IconData, type Tone } from "./icons";
import { Markdown } from "./markdown";
import { confirm } from "./confirm-store";
import { ErrorNotice, PageScroll, PullDown, tap, useStyles } from "./ui";
import { fonts, useTheme } from "./theme";
import { usePrDetail, usePrGuide, writePr } from "./pr-store";
import { prefillChat, sendToChat } from "./pr-chat";
import type { PrPage } from "./pr-nav";
import {
  MERGE_METHODS,
  ago,
  askPrefill,
  blockerMessage,
  guideRow,
  mergeLabel,
  middleTruncate,
  nextStop,
  openThreadsOf,
  reviewsSummary,
  threadsMessage,
  viewedCount,
} from "./pr-review";

const STATE: Record<
  PullRequestDetail["state"] | "DRAFT",
  { label: string; icon: IconData; tone: Tone; tint: "greenTint" | "purpleTint" | "redTint" | "hover" }
> = {
  OPEN: { label: "Open", icon: GitPullRequestIcon, tone: "green", tint: "greenTint" },
  DRAFT: { label: "Draft", icon: GitPullRequestDraftIcon, tone: "ink2", tint: "hover" },
  MERGED: { label: "Merged", icon: GitMergeIcon, tone: "purpleInk", tint: "purpleTint" },
  CLOSED: { label: "Closed", icon: GitPullRequestClosedIcon, tone: "red", tint: "redTint" },
};

export function PrStatePill({ pr }: { pr: PullRequestDetail }) {
  const { colors } = useTheme();
  const state = STATE[pr.state === "OPEN" && pr.isDraft ? "DRAFT" : pr.state];
  return (
    <View
      accessibilityLabel={state.label}
      style={{ height: 26, paddingHorizontal: 10, borderRadius: 13, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors[state.tint] }}
    >
      <Icon icon={state.icon} tone={state.tone} size={13} strokeWidth={2} />
      <Text style={{ color: colors[state.tone], fontSize: 13, fontWeight: "600" }}>{state.label}</Text>
    </View>
  );
}

const STATUS_ICON: Record<MergeStatus["tone"], { icon: IconData; tone: Tone; tint: "greenTint" | "redTint" | "orangeTint" | "purpleTint" | "hover" }> = {
  ready: { icon: Tick02Icon, tone: "green", tint: "greenTint" },
  blocked: { icon: Alert02Icon, tone: "red", tint: "redTint" },
  pending: { icon: Loading03Icon, tone: "orange", tint: "orangeTint" },
  merged: { icon: GitMergeIcon, tone: "purpleInk", tint: "purpleTint" },
  closed: { icon: GitPullRequestClosedIcon, tone: "red", tint: "redTint" },
  draft: { icon: GitPullRequestDraftIcon, tone: "ink2", tint: "hover" },
};

const CHECK_ICON = {
  pass: { icon: CheckmarkCircle02Icon, tone: "green" },
  fail: { icon: CancelCircleIcon, tone: "red" },
  running: { icon: Loading03Icon, tone: "orange" },
  skipped: { icon: CheckmarkCircle02Icon, tone: "green" },
  neutral: { icon: CheckmarkCircle02Icon, tone: "green" },
  none: { icon: CircleIcon, tone: "ink3" },
} as const;

export type PrOverviewProps = {
  client: Client;
  cwd: string;
  number: number;
  chatKey?: string;
  /** Opens a page of the PR: checks, threads, files, the review form, a guide stop. */
  onOpen: (page: PrPage, extra?: Record<string, string>) => void;
  /** After a message went to the Chat (or waits in its composer): the sheet closes so the Chat shows. */
  onChat: () => void;
  provider?: string;
  /** Drawn above the PR's state row: the iPad panel's mode switch. */
  header?: React.ReactNode;
};

/** The PR sheet's first page, and the iPad panel's PR mode: what the PR is, whether it can merge, and where to go next. */
export function PrOverview({ client, cwd, number, chatKey, onOpen, onChat, provider, header }: PrOverviewProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { pr, error, loading, refresh } = usePrDetail(client, cwd, number);
  const guide = usePrGuide(client, cwd, pr?.url);
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [showAll, setShowAll] = useState(false);

  async function toChat(body: string) {
    const outcome = await sendToChat(chatKey, body);
    if (outcome === "unavailable") setNotice("Open this PR's Chat to send that.");
    else onChat();
  }

  if (!pr)
    return (
      <View style={{ flex: 1 }}>
        {header}
        {error ? (
          <View style={{ padding: 20 }}>
            <ErrorNotice message={error} retry={refresh} retryTitle="Try again" />
          </View>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
            {loading && <ActivityIndicator color={colors.ink3} />}
            <Text style={styles.muted}>Reading PR #{number}…</Text>
          </View>
        )}
      </View>
    );

  const status = mergeStatus(pr);
  const open = openThreadsOf(pr);
  const outcome = checksOutcome(pr.checks) ?? "none";
  const viewed = viewedCount(pr.files);
  const row = guideRow(guide.result, pr);
  const pending = pr.pendingReview?.count ?? 0;
  const description = pr.body.trim();
  const long = description.length > 600;

  function openGuide() {
    if (row.action === "open" && guide.result?.ok && guide.result.guide) onOpen("guide", { stop: String(nextStop(guide.result.guide, guide.result.read)) });
    else if (row.action === "start") void guide.write(pr!.number, provider);
  }

  return (
    <View style={{ flex: 1 }}>
      <PageScroll
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              refresh();
              setTimeout(() => setRefreshing(false), 500);
            }}
          />
        }
        contentContainerStyle={{ gap: 14, paddingBottom: 110 }}
      >
        {header}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <PrStatePill pr={pr} />
          <Text style={{ color: colors.ink2, fontSize: 15, fontFamily: fonts.mono }}>#{pr.number}</Text>
          <View style={{ flex: 1 }} />
          <RoundButton label="Open on GitHub" icon={LinkSquare02Icon} onPress={() => void Linking.openURL(pr.url).catch(() => {})} />
          <PullDown
            label="PR actions"
            title={`PR #${pr.number}`}
            sections={[
              {
                items: [
                  { id: "copy", title: "Copy link", systemImage: "link" },
                  { id: "refresh", title: "Refresh", systemImage: "arrow.clockwise" },
                ],
              },
              ...(pr.state === "OPEN"
                ? [
                    {
                      items: [
                        pr.isDraft
                          ? { id: "ready", title: "Ready for review", systemImage: "eye" }
                          : { id: "draft", title: "Convert to draft", systemImage: "pencil.and.outline" },
                        ...(guide.result?.ok && guide.result.guide ? [{ id: "rewrite", title: "Rewrite review guide", systemImage: "sparkles" }] : []),
                      ],
                    },
                  ]
                : []),
            ]}
            onSelect={(id) => {
              if (id === "copy") void Clipboard.setStringAsync(pr.url);
              else if (id === "refresh") refresh();
              else if (id === "rewrite") void guide.write(pr.number, provider);
              else if (id === "ready" || id === "draft")
                void writePr(client, cwd, pr.number, "pr:ready", { draft: id === "draft" }).then((result) => !result.ok && setNotice(result.message));
            }}
          >
            <RoundButton label="PR actions" icon={MoreHorizontalIcon} />
          </PullDown>
        </View>
        <Text selectable accessibilityRole="header" style={{ color: colors.ink, fontSize: 20, fontWeight: "700", lineHeight: 26 }}>
          {pr.title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Avatar login={pr.author} />
          <Text numberOfLines={1} style={{ flex: 1, color: colors.ink2, fontSize: 13 }}>
            {[pr.author, ago(pr.createdAt), `${pr.changedFiles} ${pr.changedFiles === 1 ? "file" : "files"}`].filter(Boolean).join(" · ")}
          </Text>
          <Text style={{ fontFamily: fonts.mono, fontSize: 13, fontWeight: "600" }}>
            <Text style={{ color: colors.add }}>+{pr.additions}</Text> <Text style={{ color: colors.remove }}>−{pr.deletions}</Text>
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Branch ${pr.headRefName} into ${pr.baseRefName}. Copy the branch name`}
          onPress={() => {
            tap();
            void Clipboard.setStringAsync(pr.headRefName);
            setNotice(`Copied ${pr.headRefName}.`);
          }}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, opacity: pressed ? 0.6 : 1 })}
        >
          <BranchChip text={pr.baseRefName} />
          <Icon icon={ArrowLeft01Icon} tone="ink3" size={13} />
          <View style={{ flexShrink: 1 }}>
            <BranchChip text={middleTruncate(pr.headRefName, 34)} copy />
          </View>
        </Pressable>
        <MergeCard pr={pr} status={status} client={client} cwd={cwd} onFix={(body) => void toChat(body)} onError={setNotice} />
        {!!notice && (
          <Text accessibilityLiveRegion="polite" style={[styles.caption, { paddingHorizontal: 4 }]}>
            {notice}
          </Text>
        )}
        <View style={[styles.card, { padding: 0, gap: 0 }]}>
          <GroupRow
            icon={CHECK_ICON[outcome].icon}
            tone={CHECK_ICON[outcome].tone}
            title="Checks"
            value={pr.checks.length ? checksSummary(pr.checks) : "None"}
            onPress={pr.checks.length ? () => onOpen("checks") : undefined}
          />
          <Separator />
          <GroupRow
            icon={open.length ? BubbleChatIcon : Tick02Icon}
            tone={open.length ? "orange" : pr.reviewDecision === "APPROVED" ? "green" : "ink2"}
            title={reviewsSummary(pr)}
            onPress={() => onOpen("threads")}
            trailing={open.length ? <FixButton onPress={() => void toChat(threadsMessage(pr, open))} /> : undefined}
          />
          <Separator />
          <GroupRow
            icon={SparklesIcon}
            tone="accent"
            title="Review guide"
            value={row.action === "start" ? undefined : row.stale ? "Before the latest push" : row.value}
            loading={row.action === "writing"}
            onPress={row.action === "writing" ? undefined : openGuide}
            trailing={row.action === "start" ? <SmallButton title="Start" onPress={openGuide} /> : undefined}
          />
          {(row.error || row.stale) && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 12 }}>
              <Text style={[styles.caption, { flex: 1, color: row.error ? colors.red : colors.ink3 }]}>{row.error || "Written before the latest push."}</Text>
              <SmallButton title={row.error ? "Try again" : "Rewrite"} onPress={() => void guide.write(pr.number, provider)} />
            </View>
          )}
          <Separator />
          <GroupRow icon={FileDiffIcon} tone="ink2" title="Files" value={`${viewed.viewed} of ${viewed.total} viewed`} onPress={() => onOpen("files")} />
        </View>
        {!!description && (
          <View style={{ gap: 6 }}>
            <Text style={[styles.label, { color: colors.ink3, paddingHorizontal: 4 }]}>Description</Text>
            <View style={{ paddingHorizontal: 4 }}>
              <Markdown text={long && !showAll ? `${description.slice(0, 600).trimEnd()}…` : description} />
            </View>
            {long && (
              <Pressable accessibilityRole="button" onPress={() => setShowAll((value) => !value)} style={{ paddingHorizontal: 4, paddingVertical: 6 }}>
                <Text style={{ color: colors.accentInk, fontSize: 14, fontWeight: "600" }}>{showAll ? "Show less" : "Show all"}</Text>
              </Pressable>
            )}
          </View>
        )}
      </PageScroll>
      <View pointerEvents="box-none" style={{ position: "absolute", left: 16, right: 16, bottom: 20 }}>
        <View
          style={{
            flexDirection: "row",
            gap: 8,
            padding: 6,
            borderRadius: 28,
            borderCurve: "continuous",
            backgroundColor: colors.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.lineStrong,
            shadowColor: "#000",
            shadowOpacity: 0.25,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 6 },
          }}
        >
          <BarButton
            title="Ask Chat"
            icon={SparklesIcon}
            onPress={() => {
              if (prefillChat(chatKey, askPrefill(pr))) onChat();
              else setNotice("Open this PR's Chat to ask about it.");
            }}
          />
          <BarButton title="Review" icon={MessageAdd01Icon} badge={pending} filled onPress={() => onOpen("review")} />
        </View>
      </View>
    </View>
  );
}

/** Whether it can merge, and the button that does it: merge now, auto-merge, merge anyway (admins) or ready for review. */
function MergeCard({
  pr,
  status,
  client,
  cwd,
  onFix,
  onError,
}: {
  pr: PullRequestDetail;
  status: MergeStatus;
  client: Client;
  cwd: string;
  onFix: (body: string) => void;
  onError: (message: string) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [busy, setBusy] = useState(false);
  const icon = STATUS_ICON[status.tone];
  const fix = blockerMessage(pr, status);
  const now = canMergeNow(pr);
  const open = pr.state === "OPEN";

  async function run(request: Record<string, unknown>, method_ = "pr:merge") {
    setBusy(true);
    const result = await writePr(client, cwd, pr.number, method_, request);
    setBusy(false);
    onError(result.ok ? "" : result.message);
  }
  async function merge(admin = false) {
    const label = admin ? "Merge anyway" : mergeLabel(method);
    if (await confirm(`${label}?`, `PR #${pr.number} goes into ${pr.baseRefName}.`, label)) await run({ method, admin });
  }

  return (
    <View style={[styles.card, { gap: 14 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: colors[icon.tint], alignItems: "center", justifyContent: "center" }}>
          <Icon icon={icon.icon} tone={icon.tone} size={18} strokeWidth={2.2} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "600" }}>{status.title}</Text>
          <Text style={{ color: colors.ink2, fontSize: 13 }}>{pr.autoMerge && open ? `Auto-merge is on (${pr.autoMerge.method})` : status.detail}</Text>
        </View>
        {fix && <FixButton onPress={() => onFix(fix)} />}
      </View>
      {open && pr.isDraft && <WideButton title="Ready for review" disabled={busy} onPress={() => void run({ draft: false }, "pr:ready")} />}
      {open && !pr.isDraft && now && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <WideButton title={mergeLabel(method)} icon={GitMergeIcon} green busy={busy} onPress={() => void merge()} />
          <PullDown
            label="Merge method"
            title="Merge method"
            sections={[{ items: MERGE_METHODS.map((entry) => ({ id: entry.value, title: entry.title, checked: entry.value === method })) }]}
            onSelect={(id) => setMethod(id as MergeMethod)}
          >
            <View
              accessibilityLabel="Merge method"
              style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.greenTint, alignItems: "center", justifyContent: "center" }}
            >
              <Icon icon={ArrowDown01Icon} tone="green" size={18} strokeWidth={2} />
            </View>
          </PullDown>
        </View>
      )}
      {open && !pr.isDraft && !now && (
        <View style={{ gap: 8 }}>
          {pr.autoMerge ? (
            <WideButton title="Turn off auto-merge" secondary disabled={busy} onPress={() => void run({ disableAuto: true })} />
          ) : (
            <WideButton
              title={`Auto-merge (${method})`}
              secondary
              disabled={busy}
              onPress={() =>
                void confirm("Turn on auto-merge?", `PR #${pr.number} merges into ${pr.baseRefName} once its requirements pass.`, "Auto-merge").then((yes) =>
                  yes ? run({ method, auto: true }) : undefined,
                )
              }
            />
          )}
          {pr.viewerCanMergeAsAdmin && status.tone !== "pending" && (
            <WideButton title="Merge anyway" secondary disabled={busy} onPress={() => void merge(true)} />
          )}
        </View>
      )}
    </View>
  );
}

export function Avatar({ login, size = 18 }: { login: string; size?: number }) {
  const { colors } = useTheme();
  const hues = [colors.accent, colors.green, colors.orange, colors.purple, colors.red];
  const hue = hues[[...login].reduce((sum, char) => sum + char.charCodeAt(0), 0) % hues.length];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: hue, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: colors.page, fontSize: size * 0.55, fontWeight: "700" }}>{login.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

function BranchChip({ text, copy = false }: { text: string; copy?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, height: 24, borderRadius: 6, backgroundColor: colors.surface }}>
      <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink2, fontSize: 12, fontFamily: fonts.mono }}>
        {text}
      </Text>
      {copy && <Icon icon={Copy01Icon} tone="ink3" size={12} />}
    </View>
  );
}

function RoundButton({ label, icon, onPress }: { label: string; icon: IconData; onPress?: () => void }) {
  const { colors } = useTheme();
  const body = (
    <View
      accessible={!onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.lineStrong,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon icon={icon} tone="ink" size={16} />
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {body}
    </Pressable>
  );
}

export function Separator({ inset = 16 }: { inset?: number }) {
  const { colors } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: inset }} />;
}

function GroupRow({
  icon,
  tone,
  title,
  value,
  onPress,
  trailing,
  loading = false,
}: {
  icon: IconData;
  tone: Tone;
  title: string;
  value?: string;
  onPress?: () => void;
  trailing?: React.ReactNode;
  loading?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${title}, ${value}` : title}
      disabled={!onPress}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => ({ minHeight: 52, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, opacity: pressed ? 0.55 : 1 })}
    >
      <Icon icon={icon} tone={tone} size={20} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 17 }}>
        {title}
      </Text>
      {loading && <ActivityIndicator color={colors.ink3} />}
      {!!value && (
        <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 15, maxWidth: 170 }}>
          {value}
        </Text>
      )}
      {trailing}
      {onPress && !trailing && <Icon icon={ArrowRight01Icon} tone="ink3" size={14} />}
    </Pressable>
  );
}

export function FixButton({ onPress, title = "Fix in Chat" }: { onPress: () => void; title?: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        height: 30,
        paddingHorizontal: 12,
        borderRadius: 15,
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        backgroundColor: colors.accentTint,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon icon={SparklesIcon} tone="accentInk" size={13} />
      <Text style={{ color: colors.accentInk, fontSize: 14, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}

export function SmallButton({
  title,
  onPress,
  tone = "accentInk",
  filled = false,
  disabled = false,
  busy = false,
}: {
  title: string;
  onPress: () => void;
  tone?: Tone;
  filled?: boolean;
  disabled?: boolean;
  busy?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        height: 34,
        paddingHorizontal: 14,
        borderRadius: 17,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: filled ? colors.ink : colors.hover,
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      {busy && <ActivityIndicator size="small" color={filled ? colors.onInk : colors.ink2} />}
      <Text style={{ color: filled ? colors.onInk : colors[tone], fontSize: 14, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}

export function WideButton({
  title,
  icon,
  onPress,
  green = false,
  secondary = false,
  disabled = false,
  busy = false,
}: {
  title: string;
  icon?: IconData;
  onPress: () => void;
  green?: boolean;
  secondary?: boolean;
  disabled?: boolean;
  busy?: boolean;
}) {
  const { colors } = useTheme();
  const fill = green ? colors.green : secondary ? colors.hover : colors.ink;
  const ink = green ? colors.page : secondary ? colors.ink : colors.onInk;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        flex: 1,
        height: 48,
        borderRadius: 24,
        borderCurve: "continuous",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        backgroundColor: fill,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      {busy ? <ActivityIndicator color={ink} /> : icon ? <Icon icon={icon} color={ink} size={17} strokeWidth={2} /> : null}
      <Text style={{ color: ink, fontSize: 17, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}

function BarButton({
  title,
  icon,
  onPress,
  badge = 0,
  filled = false,
}: {
  title: string;
  icon: IconData;
  onPress: () => void;
  badge?: number;
  filled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge ? `${title}, ${badge} pending` : title}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        flex: 1,
        height: 44,
        borderRadius: 22,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        backgroundColor: filled ? colors.hover2 : "transparent",
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon icon={icon} tone="ink" size={17} />
      <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "600" }}>{title}</Text>
      {badge > 0 && (
        <View
          style={{
            minWidth: 20,
            height: 20,
            paddingHorizontal: 5,
            borderRadius: 10,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: colors.page, fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{badge}</Text>
        </View>
      )}
    </Pressable>
  );
}

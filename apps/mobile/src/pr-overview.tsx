import React, { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import {
  Alert02Icon,
  ArrowDown01Icon,
  Cancel01Icon,
  CloudUploadIcon,
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
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import {
  canMergeNow,
  checksOutcome,
  checksSummary,
  mergeStatus,
  notInPrLabel,
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
import { prChoiceKey, prefillChat, sendToChat, type PrChoice } from "./pr-chat";
import { isOldMacError } from "./file-mentions";
import { useRpc } from "./use-rpc";
import type { PrPage } from "./pr-nav";
import type { DiffFilesResult, DiffMode } from "@milagre/shared/git-diff";
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

function PrStatePill({ pr }: { pr: PullRequestDetail }) {
  const { colors } = useTheme();
  const state = STATE[pr.state === "OPEN" && pr.isDraft ? "DRAFT" : pr.state];
  return (
    <View
      accessibilityLabel={state.label}
      style={{ height: 34, paddingHorizontal: 12, borderRadius: 17, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors[state.tint] }}
    >
      <Icon icon={state.icon} tone={state.tone} size={14} strokeWidth={2} />
      <Text style={{ color: colors[state.tone], fontSize: 15, fontWeight: "600" }}>{state.label}</Text>
    </View>
  );
}

/**
 * The PR's number; when the Chat has opened more than one PR, a menu listing each (and the changes not in a PR yet) that
 * switches the panel to another.
 */
function PrSwitcher({
  number,
  cwd,
  choices,
  onPick,
  local,
  onChanges,
}: {
  number: number;
  choices: PrChoice[];
  onPick?: (key: string) => void;
  /** The folder the PR is read in, which tells a Link Chat's PRs with the same number apart. */
  cwd?: string;
  /** What isn't in a PR yet ("2 files · 1 commit"); empty when nothing. */
  local: string;
  onChanges?: () => void;
}) {
  const { colors } = useTheme();
  if (choices.length < 2 || !onPick) return <Text style={{ color: colors.ink2, fontSize: 15, fontFamily: fonts.mono }}>#{number}</Text>;
  return (
    <PullDown
      label="Switch PR"
      title="This Chat's PRs"
      sections={[
        {
          items: choices.map((choice, index) => ({
            id: `pr:${index}`,
            title: `#${choice.number} · ${choice.state === "MERGED" ? "Merged" : "Open"}`,
            // A Link Chat's PRs come from different Projects: each says which.
            subtitle: choice.project ? `${choice.project} · ${choice.title}` : choice.title,
            checked: choice.number === number && (!choice.cwd || choice.cwd === cwd),
          })),
        },
        ...(local && onChanges
          ? [
              {
                items: [
                  {
                    id: "changes",
                    title: "Local changes",
                    subtitle: `${local} not in a PR yet`,
                    systemImage: "doc.badge.plus",
                  },
                ],
              },
            ]
          : []),
      ]}
      onSelect={(id) => {
        if (id === "changes") onChanges?.();
        else if (id.startsWith("pr:")) {
          const choice = choices[Number(id.slice(3))];
          if (choice) onPick(prChoiceKey(choice));
        }
      }}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={`PR #${number}, ${choices.length} PRs`}
        style={{
          height: 34,
          paddingHorizontal: 12,
          borderRadius: 17,
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          backgroundColor: colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.lineStrong,
        }}
      >
        <Text style={{ color: colors.ink, fontSize: 15, fontWeight: "600" }}>#{number}</Text>
        <Text style={{ color: colors.ink2, fontSize: 13 }}>of {choices.length}</Text>
        <Icon icon={UnfoldMoreIcon} tone="ink2" size={13} />
      </View>
    </PullDown>
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

const NO_CHOICES: PrChoice[] = [];

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
  /** Closes the panel or sheet: the X in the top row. */
  onClose?: () => void;
  /** The Chat's PRs; with more than one, the number opens a menu to switch between them. */
  choices?: PrChoice[];
  onPick?: (key: string) => void;
  /** Shows the Worktree's changes that aren't in the PR yet, uncommitted ones first; without it there is no such row. */
  onChanges?: (mode: DiffMode) => void;
};

/** The PR sheet's first page, and the iPad panel's PR mode: what the PR is, whether it can merge, and where to go next. */
export function PrOverview({ client, cwd, number, chatKey, onOpen, onChat, provider, onClose, choices = NO_CHOICES, onPick, onChanges }: PrOverviewProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { pr, error, loading, refresh } = usePrDetail(client, cwd, number);
  const guide = usePrGuide(client, cwd, pr?.url);
  // A Mac from before the PR panel has no pr:* commands; the branch's PR (and its address) still comes from the older call.
  const oldMac = !pr && isOldMacError(error);
  const { data: branchPr } = useRpc<{ number: number; url: string } | null>(oldMac ? client : null, "worktree:pull-request", [cwd]);
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // The Worktree's uncommitted files: changes the PR doesn't have yet.
  const local = useRpc<DiffFilesResult>(onChanges ? client : null, "git:diff-files", [{ cwd, mode: "uncommitted" }]);
  const [localCount, setLocalCount] = useState(0);
  const counted = local.data?.isRepo ? local.data.files.length : null;
  // A refresh reads the list again; the row keeps the last count meanwhile.
  if (counted !== null && counted !== localCount) setLocalCount(counted);
  // And the commits made here that the open PR's head doesn't have.
  const commits = pr?.state === "OPEN" ? (pr.localCommits ?? 0) : 0;
  const localText = onChanges ? notInPrLabel(localCount, commits) : "";
  const openChanges = onChanges ? () => onChanges(localCount > 0 ? "uncommitted" : "committed") : undefined;
  const switcher = <PrSwitcher number={number} cwd={cwd} choices={choices} onPick={onPick} local={localText} onChanges={openChanges} />;
  const close = onClose ? <RoundButton label="Close" icon={Cancel01Icon} onPress={onClose} /> : null;

  async function toChat(body: string) {
    const outcome = await sendToChat(chatKey, body);
    if (outcome === "unavailable") setNotice("Open this PR's Chat to send that.");
    else onChat();
  }

  if (!pr)
    return (
      <View style={{ flex: 1 }}>
        {(close || choices.length > 1) && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 }}>
            {switcher}
            <View style={{ flex: 1 }} />
            {close}
          </View>
        )}
        {oldMac ? (
          <View style={{ padding: 20, gap: 14 }}>
            <Text style={[styles.label, { fontSize: 16 }]}>Update Milagre on this Mac to review PR #{number} here.</Text>
            <Text style={styles.muted}>{"This Mac's Milagre is older than the PR panel."}</Text>
            {branchPr?.number === number && branchPr.url && (
              <View style={{ flexDirection: "row" }}>
                <WideButton title="Open on GitHub" icon={LinkSquare02Icon} secondary onPress={() => void Linking.openURL(branchPr.url).catch(() => {})} />
              </View>
            )}
          </View>
        ) : error ? (
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
    <View collapsable={false} style={{ flex: 1 }}>
      <PageScroll
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              refresh();
              local.refresh();
              setTimeout(() => setRefreshing(false), 500);
            }}
          />
        }
        contentContainerStyle={{ gap: 14, paddingBottom: 40 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <PrStatePill pr={pr} />
          {switcher}
          <View style={{ flex: 1 }} />
          <RoundButton label="Open on GitHub" icon={LinkSquare02Icon} onPress={() => void Linking.openURL(pr.url).catch(() => {})} />
          <PullDown
            label="PR actions"
            title={`PR #${pr.number}`}
            sections={[
              {
                items: [
                  { id: "ask", title: "Ask Chat", systemImage: "sparkles" },
                  ...(pr.state === "OPEN" ? [{ id: "review", title: pending ? `Submit review (${pending})` : "Review", systemImage: "text.bubble" }] : []),
                ],
              },
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
              if (id === "ask") {
                if (prefillChat(chatKey, askPrefill(pr))) onChat();
                else setNotice("Open this PR's Chat to ask about it.");
              } else if (id === "review") onOpen("review");
              else if (id === "copy") void Clipboard.setStringAsync(pr.url);
              else if (id === "refresh") refresh();
              else if (id === "rewrite") void guide.write(pr.number, provider);
              else if (id === "ready" || id === "draft")
                void writePr(client, cwd, pr.number, "pr:ready", { draft: id === "draft" }).then((result) => !result.ok && setNotice(result.message));
            }}
          >
            <RoundButton label="PR actions" icon={MoreHorizontalIcon} />
          </PullDown>
          {close}
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
          {pending > 0 && pr.state === "OPEN" && (
            <>
              <Separator />
              <GroupRow
                icon={MessageAdd01Icon}
                tone="accent"
                title={`${pending} draft ${pending === 1 ? "comment" : "comments"}`}
                onPress={() => onOpen("review")}
                trailing={<SmallButton title="Submit" onPress={() => onOpen("review")} />}
              />
            </>
          )}
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
          {openChanges && !!localText && pr.state === "OPEN" && (
            <>
              <Separator />
              <GroupRow icon={CloudUploadIcon} tone="orange" title="Not in the PR yet" value={localText} onPress={openChanges} />
            </>
          )}
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
          <WideButton title={mergeLabel(method)} icon={GitMergeIcon} green={status.tone === "ready"} busy={busy} onPress={() => void merge()} />
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

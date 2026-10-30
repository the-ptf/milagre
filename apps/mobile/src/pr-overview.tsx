import React, { useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpDownIcon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  CloudUploadIcon,
  GitMergeIcon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  PlusSignIcon,
  Tag01Icon,
  UserAdd01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { canMergeNow, checksProgress, mergeStatus, type MergeMethod } from "@milagre/shared/pull-request-review";
import { AUTO_MERGE_LABEL, pullRequestStatePill } from "@milagre/shared/pr-blockers";
import type { Client } from "./client";
import { hitSlopFor, lineHeight, radius, type } from "./design-tokens";
import { Icon, SpinnerRing, type IconData } from "./icons";
import { PrMarkdown } from "./pr-markdown";
import { confirm } from "./confirm-store";
import { CircleButton, ErrorNotice, PageScroll, PillButton, pressStyle, PullDown, Segmented, Tag, tap, useAnnounce, useStyles } from "./ui";
import { fonts, inkFor, useTheme } from "./theme";
import { usePrDetail, writePr } from "./pr-store";
import { prChoiceKey, prefillChat, type PrChoice } from "./pr-chat";
import { isOldMacError } from "./file-mentions";
import { useRpc } from "./use-rpc";
import { ProjectIcon } from "./project-icon";
import type { PrPage } from "./pr-nav";
import type { DiffFilesResult } from "@milagre/shared/git-diff";
import { Avatar, CheckList, FileList, PrComments, Separator, VERDICT } from "./pr-lists";
import { MERGE_METHODS, agoLabel, askPrefill, mergeLabel, middleTruncate, notInPrLine, repoOf } from "./pr-review";

const NO_CHOICES: PrChoice[] = [];

export type PrOverviewProps = {
  client: Client;
  cwd: string;
  number: number;
  chatKey?: string;
  /** Opens a page of the PR: the comments, the review form, a file's diff, the labels or reviewers picker. */
  onOpen: (page: PrPage, extra?: Record<string, string>) => void;
  /** After a message waits in the Chat's composer: the sheet closes so the Chat shows. */
  onChat: () => void;
  /** Closes the panel or sheet: the X in the top row. */
  onClose?: () => void;
  /** The Chat's PRs; with more than one, the ⋯ menu switches between them. */
  choices?: PrChoice[];
  onPick?: (key: string) => void;
  /** A Link Chat's PR names the Project it belongs to. */
  project?: { name: string; path: string };
  /** Shows the Worktree's changes that aren't in the PR yet; without it there is no such line. */
  onChanges?: () => void;
};

/** The PR sheet's first page, and the iPad panel's PR tab: what the PR is, its checks, people, labels and comments. */
export function PrOverview({ client, cwd, number, chatKey, onOpen, onChat, onClose, choices = NO_CHOICES, onPick, onChanges, project }: PrOverviewProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { pr, error, loading, refresh } = usePrDetail(client, cwd, number);
  // A Mac from before the PR panel has no pr:* commands; the branch's PR (and its address) still comes from the older call.
  const oldMac = !pr && isOldMacError(error);
  const { data: branchPr } = useRpc<{ number: number; url: string } | null>(oldMac ? client : null, "worktree:pull-request", [cwd]);
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"summary" | "files">("summary");
  const [open, setOpen] = useState({ description: false, checks: false, comments: true });
  const [newestFirst, setNewestFirst] = useState(true);
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [busy, setBusy] = useState(false);
  // The Worktree's uncommitted files: changes the PR doesn't have yet.
  const local = useRpc<DiffFilesResult>(onChanges ? client : null, "git:diff-files", [{ cwd, mode: "uncommitted" }]);
  const [localCount, setLocalCount] = useState(0);
  const counted = local.data?.isRepo ? local.data.files.length : null;
  // A refresh reads the list again; the line keeps the last count meanwhile.
  if (counted !== null && counted !== localCount) setLocalCount(counted);
  useAnnounce(notice);
  const close = onClose ? <CircleButton label="Close" icon={Cancel01Icon} onPress={onClose} /> : null;

  if (!pr)
    return (
      <View style={{ flex: 1 }}>
        {close && <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>{close}</View>}
        {oldMac ? (
          <View style={{ padding: 16, gap: 12 }}>
            <Text style={[styles.label, { fontSize: type.callout, lineHeight: lineHeight.callout }]}>
              Update Milagre on this Mac to review PR #{number} here.
            </Text>
            <Text style={styles.muted}>{"This Mac's Milagre is older than the PR panel."}</Text>
            {branchPr?.number === number && branchPr.url && (
              <View style={{ flexDirection: "row" }}>
                <PillButton title="Open on GitHub" icon={LinkSquare02Icon} secondary onPress={() => void Linking.openURL(branchPr.url).catch(() => {})} />
              </View>
            )}
          </View>
        ) : error ? (
          <View style={{ padding: 16 }}>
            <ErrorNotice message={error} retry={refresh} retryTitle="Try again" />
          </View>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
            {loading && <SpinnerRing size={20} />}
            <Text style={styles.muted}>Reading PR #{number}…</Text>
          </View>
        )}
      </View>
    );

  const status = mergeStatus(pr);
  const statePill = pullRequestStatePill(pr);
  const now = canMergeNow(pr);
  const isOpen = pr.state === "OPEN";
  const pending = pr.pendingReview?.count ?? 0;
  const progress = checksProgress(pr.checks);
  const description = pr.body.trim();
  const commentCount = pr.comments.length + pr.threads.filter((thread) => !thread.resolved).length;
  // The commits made here that the open PR's head doesn't have, with the uncommitted files.
  const localLine = onChanges && isOpen ? notInPrLine(localCount, pr.localCommits ?? 0) : "";
  const openGitHub = () => void Linking.openURL(pr.url).catch(() => {});

  async function run(request: Record<string, unknown>, channel = "pr:merge") {
    setBusy(true);
    const result = await writePr(client, cwd, pr!.number, channel, request);
    setBusy(false);
    setNotice(result.ok ? "" : result.message);
  }
  async function merge(admin = false) {
    const label = admin ? "Merge anyway" : mergeLabel(method);
    if (await confirm(`${label}?`, `PR #${pr!.number} goes into ${pr!.baseRefName}.`, label)) await run({ method, admin });
  }
  async function mergeWhenReady() {
    if (await confirm("Merge when ready?", `PR #${pr!.number} merges into ${pr!.baseRefName} once its requirements pass.`, "Merge when ready"))
      await run({ method, auto: true });
  }

  // GitHub can't merge a branch that conflicts, even when asked to merge it once ready.
  const conflicts = pr.mergeStateStatus === "DIRTY";
  // The one action the PR is waiting for: nothing once it is merged or closed, or while it conflicts. Merge is the primary.
  const action = !isOpen ? null : pr.isDraft ? (
    <PillButton size="small" secondary title="Ready for review" loading={busy} onPress={() => void run({ draft: false }, "pr:ready")} />
  ) : now ? (
    <PillButton size="small" title="Merge" icon={GitMergeIcon} loading={busy} onPress={() => void merge()} />
  ) : pr.autoMerge ? (
    <PillButton
      size="small"
      secondary
      title={AUTO_MERGE_LABEL}
      icon={GitMergeIcon}
      loading={busy}
      onPress={() =>
        void confirm("Turn off auto-merge?", `PR #${pr.number} stays open.`, "Turn off").then((yes) => (yes ? run({ disableAuto: true }) : undefined))
      }
    />
  ) : conflicts ? null : (
    <PillButton size="small" secondary title="Merge when ready" icon={GitMergeIcon} loading={busy} onPress={() => void mergeWhenReady()} />
  );

  const menu = (
    <PullDown
      label="PR actions"
      hitSlop={hitSlopFor(40)}
      title={pr.autoMerge && isOpen ? `Auto-merge is on (${pr.autoMerge.method})` : status.detail}
      sections={[
        ...(isOpen && !pr.isDraft
          ? [
              {
                title: "Merge method",
                items: MERGE_METHODS.map((entry) => ({ id: `method:${entry.value}`, title: entry.title, checked: entry.value === method })),
              },
              {
                items: [
                  ...(!now && !conflicts && pr.viewerCanMergeAsAdmin && status.tone !== "pending"
                    ? [{ id: "admin", title: "Merge anyway", systemImage: "exclamationmark.triangle" }]
                    : []),
                  ...(pr.autoMerge ? [{ id: "auto-off", title: "Turn off auto-merge", systemImage: "xmark.circle" }] : []),
                  { id: "draft", title: "Convert to draft", systemImage: "pencil.and.outline" },
                ],
              },
            ]
          : []),
        {
          items: [
            ...(isOpen ? [{ id: "review", title: pending ? `Submit review (${pending})` : "Review", systemImage: "text.bubble" }] : []),
            { id: "ask", title: "Ask Chat", systemImage: "sparkles" },
          ],
        },
        ...(choices.length > 1 && onPick
          ? [
              {
                title: "This Chat's PRs",
                items: choices.map((choice, index) => ({
                  id: `pr:${index}`,
                  title: `#${choice.number} ${choice.title}`,
                  // A Link Chat's PRs come from different Projects: each says which.
                  subtitle: choice.project,
                  checked: choice.number === number && (!choice.cwd || choice.cwd === cwd),
                })),
              },
            ]
          : []),
        {
          items: [
            { id: "github", title: "Open on GitHub", systemImage: "safari" },
            { id: "copy", title: "Copy link", systemImage: "link" },
            { id: "refresh", title: "Refresh", systemImage: "arrow.clockwise" },
          ],
        },
      ]}
      onSelect={(id) => {
        if (id.startsWith("method:")) setMethod(id.slice(7) as MergeMethod);
        else if (id === "admin") void merge(true);
        else if (id === "auto-off") void run({ disableAuto: true });
        else if (id === "draft") void run({ draft: true }, "pr:ready");
        else if (id === "review") onOpen("review");
        else if (id === "ask") {
          if (prefillChat(chatKey, askPrefill(pr))) onChat();
          else setNotice("Open this PR's Chat to ask about it.");
        } else if (id.startsWith("pr:")) {
          const choice = choices[Number(id.slice(3))];
          if (choice) onPick?.(prChoiceKey(choice));
        } else if (id === "github") openGitHub();
        else if (id === "copy") void Clipboard.setStringAsync(pr.url);
        else if (id === "refresh") refresh();
      }}
    >
      <CircleButton label="PR actions" icon={MoreHorizontalIcon} asTrigger />
    </PullDown>
  );

  const toggle = (key: keyof typeof open) => setOpen((current) => ({ ...current, [key]: !current[key] }));

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
        contentContainerStyle={{ gap: 12, paddingBottom: 40 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`${repoOf(pr.url)} #${pr.number}${statePill ? `, ${statePill.label}` : ""}, open on GitHub`}
            onPress={openGitHub}
            style={({ pressed }) => [{ flex: 1, flexDirection: "row", alignItems: "center", gap: 4 }, pressStyle({ pressed })]}
          >
            <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
              {repoOf(pr.url)}
            </Text>
            <Text style={{ color: colors.accentInk, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>#{pr.number}</Text>
            <Icon icon={LinkSquare02Icon} tone="accentInk" size={12} />
            {statePill && (
              <View
                style={{
                  minHeight: 20,
                  paddingHorizontal: 8,
                  marginLeft: 2,
                  borderRadius: radius.full,
                  justifyContent: "center",
                  backgroundColor: colors[statePill.fill],
                }}
              >
                <Text
                  maxFontSizeMultiplier={1.5}
                  style={{ color: colors[statePill.ink], fontSize: type.caption2, lineHeight: lineHeight.caption2, fontWeight: "600" }}
                >
                  {statePill.label}
                </Text>
              </View>
            )}
          </Pressable>
          {action}
          {menu}
          {close}
        </View>
        {project && (
          <View accessible accessibilityLabel={`Project ${project.name}`} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <ProjectIcon client={client} path={project.path} size={20} />
            <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "600" }}>
              {project.name}
            </Text>
          </View>
        )}
        <Text selectable accessibilityRole="header" style={{ color: colors.ink, fontSize: type.title3, fontWeight: "600", lineHeight: lineHeight.title3 }}>
          {pr.title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Avatar login={pr.author} size={20} />
          <Text numberOfLines={1} style={{ flex: 1, color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
            <Text style={{ color: colors.ink, fontWeight: "600" }}>{pr.author}</Text>
            {pr.updatedAt ? ` · updated ${agoLabel(pr.updatedAt)}` : ""}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Branch ${pr.headRefName} into ${pr.baseRefName}. Copy the branch name`}
            onPress={() => {
              tap();
              void Clipboard.setStringAsync(pr.headRefName);
              setNotice(`Copied ${pr.headRefName}.`);
            }}
            style={({ pressed }) => [{ flex: 1, flexDirection: "row", alignItems: "center", gap: 4 }, pressStyle({ pressed })]}
          >
            <Text style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1, fontFamily: fonts.mono }}>{pr.baseRefName}</Text>
            <Icon icon={ArrowLeft01Icon} tone="ink3" size={12} />
            <Text
              numberOfLines={1}
              style={{ flexShrink: 1, color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1, fontFamily: fonts.mono }}
            >
              {middleTruncate(pr.headRefName, 28)}
            </Text>
          </Pressable>
          <Text style={{ color: colors.ink2, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
            {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"} <Text style={{ fontFamily: fonts.mono, color: colors.add }}>+{pr.additions}</Text>{" "}
            <Text style={{ fontFamily: fonts.mono, color: colors.remove }}>−{pr.deletions}</Text>
          </Text>
        </View>
        {(status.tone === "blocked" || status.tone === "draft") && (
          <View accessible accessibilityLabel={`${status.title}. ${status.detail}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon icon={AlertCircleIcon} tone={status.tone === "blocked" ? "red" : "ink3"} size={16} />
            <Text numberOfLines={2} style={{ flex: 1, color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
              <Text style={{ color: status.tone === "blocked" ? colors.redInk : colors.ink, fontWeight: "600" }}>{status.title}</Text> · {status.detail}
            </Text>
          </View>
        )}
        {!!localLine && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${localLine}. Show the changes`}
            onPress={() => {
              tap();
              onChanges?.();
            }}
            style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 }, pressStyle({ pressed })]}
          >
            <Icon icon={CloudUploadIcon} tone="orange" size={16} />
            <Text style={{ color: colors.orangeInk, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{localLine}</Text>
            <Icon icon={ArrowRight01Icon} tone="orange" size={12} />
          </Pressable>
        )}
        {!!notice && <Text style={styles.caption}>{notice}</Text>}
        <Segmented
          label="PR view"
          value={tab}
          options={[
            { value: "summary", title: "Summary" },
            { value: "files", title: `Files ${pr.files.length}` },
          ]}
          onChange={(value) => setTab(value as "summary" | "files")}
        />
        {progress.total > 0 && <ChecksLine progress={progress} />}
        {tab === "files" ? (
          <FileList pr={pr} onOpenFile={(file) => onOpen("diff", { path: file.path })} />
        ) : (
          <>
            <View style={[styles.card, { padding: 0, gap: 0 }]}>
              <PropertyRow icon={UserGroupIcon} title="Reviewers" add={UserAdd01Icon} onPress={isOpen ? () => onOpen("reviewers") : undefined}>
                {pr.reviewers.length ? (
                  <View style={{ flexDirection: "row" }}>
                    {pr.reviewers.map((reviewer, index) => (
                      <View key={reviewer.login} style={{ marginLeft: index ? -6 : 0 }}>
                        <Avatar login={reviewer.login} size={24} ring={colors[VERDICT[reviewer.state].tone]} team={reviewer.team} />
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={styles.caption}>None</Text>
                )}
              </PropertyRow>
              <Separator inset={46} />
              <PropertyRow icon={Tag01Icon} title="Labels" add={PlusSignIcon} onPress={isOpen ? () => onOpen("labels") : undefined}>
                {pr.labels.length ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                    {pr.labels.map((label) => (
                      <Tag key={label.name} label={label.name} tint={`#${label.color}33`} square />
                    ))}
                  </View>
                ) : (
                  <Text style={styles.caption}>None</Text>
                )}
              </PropertyRow>
            </View>
            {!!description && (
              <Section title="Description" open={open.description} onToggle={() => toggle("description")}>
                <View style={{ paddingHorizontal: 4 }}>
                  <PrMarkdown text={description} client={client} cwd={cwd} />
                </View>
              </Section>
            )}
            <Section title="Checks" value={pr.checks.length ? undefined : "None"} open={open.checks} onToggle={() => toggle("checks")}>
              <CheckList checks={pr.checks} />
            </Section>
            <Section
              title="Comments"
              value={String(commentCount)}
              open={open.comments}
              onToggle={() => toggle("comments")}
              trailing={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={newestFirst ? "Newest first. Show oldest first" : "Oldest first. Show newest first"}
                  hitSlop={12}
                  onPress={() => {
                    tap();
                    setNewestFirst((value) => !value);
                  }}
                  style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 4 }, pressStyle({ pressed })]}
                >
                  <Icon icon={ArrowUpDownIcon} tone="ink3" size={12} />
                  <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
                    {newestFirst ? "Newest first" : "Oldest first"}
                  </Text>
                </Pressable>
              }
            >
              <PrComments client={client} cwd={cwd} pr={pr} newestFirst={newestFirst} onOpenFile={(path) => onOpen("diff", { path })} />
            </Section>
          </>
        )}
      </PageScroll>
    </View>
  );
}

const PROGRESS_ICON = { pass: CheckmarkCircle02Icon, fail: CancelCircleIcon } as const;

/** "13 of 18 done" and the split bar under it: passed, skipped, failed, still running. */
function ChecksLine({ progress }: { progress: ReturnType<typeof checksProgress> }) {
  const { colors } = useTheme();
  const tone = progress.tone === "fail" ? "red" : progress.tone === "pass" ? "green" : "ink2";
  // ponytail: the running part is dim, not pulsing; animate it if it reads as stuck.
  const parts = [
    { key: "passed", count: progress.passed, color: colors.greenInk, opacity: 1 },
    { key: "skipped", count: progress.skipped, color: colors.lineStrong, opacity: 1 },
    { key: "failed", count: progress.failed, color: colors.redInk, opacity: 1 },
    { key: "running", count: progress.running, color: colors.orangeInk, opacity: 0.4 },
  ].filter((part) => part.count > 0);
  return (
    <View accessible accessibilityLabel={`Checks: ${progress.label}`} style={{ gap: 8, paddingHorizontal: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {progress.tone === "running" ? (
          <SpinnerRing size={16} tone="orange" />
        ) : progress.tone === "pass" || progress.tone === "fail" ? (
          <Icon icon={PROGRESS_ICON[progress.tone]} tone={tone} size={16} />
        ) : null}
        <Text
          style={{
            color: inkFor(colors, tone),
            fontSize: type.subheadline,
            lineHeight: lineHeight.subheadline,
          }}
        >
          {progress.label}
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: 2, height: 3 }}>
        {parts.map((part) => (
          <View key={part.key} style={{ flex: part.count, borderRadius: radius.full, backgroundColor: part.color, opacity: part.opacity }} />
        ))}
      </View>
    </View>
  );
}

/** Reviewers or Labels: what the PR has, and on an open PR the row opens the picker to change it. */
function PropertyRow({
  icon,
  title,
  add,
  onPress,
  children,
}: {
  icon: IconData;
  title: string;
  add: IconData;
  onPress?: () => void;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={onPress ? `${title}. Change` : title}
      disabled={!onPress}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => [
        {
          minHeight: 48,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 16,
          paddingVertical: 12,
        },
        pressStyle({ pressed, kind: "row" }),
      ]}
    >
      <Icon icon={icon} tone="ink3" size={18} />
      <Text style={{ width: 78, color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{title}</Text>
      <View style={{ flex: 1 }}>{children}</View>
      {onPress && <Icon icon={add} tone="ink3" size={18} />}
    </Pressable>
  );
}

/** A section that folds: Description, Checks, Comments. */
function Section({
  title,
  value,
  open,
  onToggle,
  trailing,
  children,
}: {
  title: string;
  value?: string;
  open: boolean;
  onToggle: () => void;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={value ? `${title}, ${value}` : title}
          accessibilityState={{ expanded: open }}
          onPress={() => {
            tap();
            onToggle();
          }}
          style={({ pressed }) => [
            {
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              minHeight: 44,
              paddingHorizontal: 4,
            },
            pressStyle({ pressed }),
          ]}
        >
          <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={12} />
          <Text style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>{title}</Text>
          {!!value && (
            <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink3, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
              {value}
            </Text>
          )}
        </Pressable>
        {open && trailing}
      </View>
      {open && children}
    </View>
  );
}

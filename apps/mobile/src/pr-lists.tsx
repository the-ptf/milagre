import React, { useState } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as Linking from "expo-linking";
import {
  BubbleChatIcon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  Loading03Icon,
  MinusSignCircleIcon,
  SparklesIcon,
  Tick02Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  PullRequestFile,
  PullRequestReviewer,
  PullRequestThread,
  RepoLabelsResult,
  ReviewEvent,
  ReviewerCandidatesResult,
} from "@milagre/shared/pull-request-review";
import type { Client } from "./client";
import { Icon, type Tone } from "./icons";
import { PrMarkdown } from "./pr-markdown";
import { ErrorNotice, PageScroll, Segmented, tap, useStyles } from "./ui";
import { fonts, useTheme } from "./theme";
import { useRpc } from "./use-rpc";
import { usePrDetail, writePr, patchDetail } from "./pr-store";
import { agoLabel, commentItems, fileName, filesByFolder, openThreadsOf, withLabels, withResolved, withReviewers } from "./pr-review";

type Base = { client: Client; cwd: string; number: number };

/** While the PR is being read for the first time, or couldn't be. */
function Waiting({ error, retry }: { error: string; retry: () => void }) {
  const { colors } = useTheme();
  return error ? (
    <View style={{ padding: 20 }}>
      <ErrorNotice message={error} retry={retry} retryTitle="Try again" />
    </View>
  ) : (
    <View style={{ paddingVertical: 48, alignItems: "center" }}>
      <ActivityIndicator color={colors.ink3} />
    </View>
  );
}

/** The ring around a reviewer's avatar: their verdict at a glance. */
export const VERDICT = {
  APPROVED: { label: "Approved", tone: "green" },
  CHANGES_REQUESTED: { label: "Changes requested", tone: "red" },
  COMMENTED: { label: "Commented", tone: "ink3" },
  REQUESTED: { label: "Review requested", tone: "orange" },
  DISMISSED: { label: "Dismissed", tone: "ink3" },
} as const satisfies Record<PullRequestReviewer["state"], { label: string; tone: string }>;

/** A GitHub user's picture; their initial on a colour when it can't load (bots, offline). A team has no picture: an icon. */
export function Avatar({ login, size = 18, ring, team = false }: { login: string; size?: number; ring?: string; team?: boolean }) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);
  const hues = [colors.accent, colors.green, colors.orange, colors.purple, colors.red];
  const hue = hues[[...login].reduce((sum, char) => sum + char.charCodeAt(0), 0) % hues.length];
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: hue,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        borderWidth: ring ? 1.5 : 0,
        borderColor: ring,
      }}
    >
      {team ? (
        <Icon icon={UserGroupIcon} color={colors.page} size={size * 0.6} />
      ) : failed ? (
        <Text style={{ color: colors.page, fontSize: size * 0.55, fontWeight: "700" }}>{login.slice(0, 1).toUpperCase()}</Text>
      ) : (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri: `https://github.com/${encodeURIComponent(login)}.png?size=40` }}
          onError={() => setFailed(true)}
          style={StyleSheet.absoluteFill}
        />
      )}
    </View>
  );
}

export function Separator({ inset = 16 }: { inset?: number }) {
  const { colors } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: inset }} />;
}

const OUTCOME = {
  fail: { icon: CancelCircleIcon, tone: "red", label: "Failed" },
  running: { icon: Loading03Icon, tone: "orange", label: "Running" },
  pass: { icon: CheckmarkCircle02Icon, tone: "green", label: "Passed" },
  skipped: { icon: MinusSignCircleIcon, tone: "ink3", label: "Skipped" },
  neutral: { icon: CircleIcon, tone: "ink3", label: "Neutral" },
} as const;

/** Every check on the PR's head with its outcome; one with a log opens it. */
export function CheckList({ checks }: { checks: PullRequestCheck[] }) {
  const styles = useStyles();
  const { colors } = useTheme();
  if (!checks.length) return <Text style={[styles.muted, { paddingHorizontal: 4 }]}>No checks on this PR.</Text>;
  return (
    <View style={[styles.card, { padding: 0, gap: 0 }]}>
      {checks.map((check, index) => {
        const outcome = OUTCOME[check.outcome];
        return (
          <View key={`${check.workflow ?? ""}/${check.name}/${check.url ?? index}`}>
            {index > 0 && <Separator inset={48} />}
            <Pressable
              accessibilityRole={check.url ? "link" : undefined}
              accessibilityLabel={`${check.name}, ${outcome.label}`}
              disabled={!check.url}
              onPress={() => check.url && void Linking.openURL(check.url).catch(() => {})}
              style={({ pressed }) => ({
                minHeight: 52,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingHorizontal: 16,
                paddingVertical: 8,
                opacity: pressed ? 0.55 : 1,
              })}
            >
              <Icon icon={outcome.icon} tone={outcome.tone} size={20} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 16 }}>
                  {check.name}
                </Text>
                {!!check.workflow && <Text style={styles.caption}>{check.workflow}</Text>}
              </View>
              <Text style={styles.caption}>{outcome.label}</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

function CommentHeader({ comment, trailing }: { comment: PullRequestComment; trailing?: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Avatar login={comment.author} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink, fontSize: 14, fontWeight: "600" }}>
        {comment.author}
      </Text>
      <Text numberOfLines={1} style={{ flex: 1, color: colors.ink3, fontSize: 13 }}>
        {comment.pending ? "" : agoLabel(comment.createdAt)}
      </Text>
      {comment.pending && <Text style={{ color: colors.accentInk, fontSize: 12, fontWeight: "600" }}>Pending</Text>}
      {trailing}
    </View>
  );
}

function cardStyle(colors: ReturnType<typeof useTheme>["colors"], accent = false) {
  return {
    borderRadius: 14,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: accent ? colors.accent : colors.lineStrong,
    backgroundColor: colors.surface,
    padding: 12,
    gap: 10,
  } as const;
}

/** A comment on the PR itself. */
function CommentCard({ comment, client, cwd }: { comment: PullRequestComment; client: Client; cwd: string }) {
  const { colors } = useTheme();
  return (
    <View style={cardStyle(colors)}>
      <CommentHeader comment={comment} />
      <PrMarkdown text={comment.body} client={client} cwd={cwd} />
    </View>
  );
}

/** One review thread: its place, its comments, then Reply and Resolve. Draft comments say so and can be deleted. */
export function ThreadCard({
  thread,
  pr,
  client,
  cwd,
  showPath = false,
  onOpenFile,
  onFix,
}: Omit<Base, "number"> & {
  thread: PullRequestThread;
  pr: PullRequestDetail;
  showPath?: boolean;
  onOpenFile?: () => void;
  /** Fix in Chat, as desktop's diff offers it on an open thread; the PR overview leaves it out. */
  onFix?: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const drafts = thread.comments.every((comment) => comment.pending);
  async function write(method: string, request: Record<string, unknown>, optimistic?: Parameters<typeof writePr>[5]) {
    setBusy(true);
    setError("");
    const result = await writePr(client, cwd, pr.number, method, request, optimistic);
    setBusy(false);
    if (!result.ok) setError(result.message);
    return result.ok;
  }
  return (
    <View style={[cardStyle(colors, drafts), { opacity: thread.resolved ? 0.7 : 1 }]}>
      {thread.comments.map((comment, index) => (
        <View key={comment.id} style={{ gap: 6 }}>
          <CommentHeader
            comment={comment}
            trailing={
              comment.pending ? (
                <SmallButton title="Delete" tone="red" onPress={() => void write("pr:delete-comment", { commentId: comment.id })} />
              ) : index === 0 && thread.resolved ? (
                <Text style={styles.caption}>Resolved</Text>
              ) : index === 0 && thread.outdated ? (
                <Text style={styles.caption}>Outdated</Text>
              ) : null
            }
          />
          {/* The place goes under the first comment's author, as on desktop. */}
          {index === 0 && showPath && (
            <Pressable accessibilityRole="button" accessibilityLabel={`Open ${thread.path}`} disabled={!onOpenFile} onPress={onOpenFile}>
              <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: colors.accentInk, fontSize: 12, fontFamily: fonts.mono }}>
                {thread.path}
                {thread.line ? `:${thread.line}` : ""}
              </Text>
            </Pressable>
          )}
          <PrMarkdown text={comment.body} client={client} cwd={cwd} />
        </View>
      ))}
      {replying && (
        <View style={{ gap: 8 }}>
          <TextInput
            autoFocus
            multiline
            value={reply}
            onChangeText={setReply}
            placeholder="Reply…"
            placeholderTextColor={colors.ink3}
            style={[styles.input, { minHeight: 64, fontSize: 15 }]}
          />
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <SmallButton title="Cancel" tone="ink2" onPress={() => setReplying(false)} />
            <SmallButton
              title="Add to review"
              filled
              busy={busy}
              disabled={!reply.trim()}
              onPress={() =>
                void write("pr:reply", { threadId: thread.id, body: reply }).then((ok) => {
                  if (ok) {
                    setReply("");
                    setReplying(false);
                  }
                  return ok;
                })
              }
            />
          </View>
        </View>
      )}
      {!replying && !drafts && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <SmallButton title="Reply" tone="ink" onPress={() => setReplying(true)} />
          <SmallButton
            title={thread.resolved ? "Unresolve" : "Resolve"}
            tone="ink"
            onPress={() =>
              void write("pr:resolve-thread", { threadId: thread.id, resolved: !thread.resolved }, (current) =>
                withResolved(current, thread.id, !thread.resolved),
              )
            }
          />
          {onFix && !thread.resolved && (
            <>
              <View style={{ flex: 1 }} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Fix in Chat"
                hitSlop={6}
                onPress={() => {
                  tap();
                  onFix();
                }}
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 5, height: 34, opacity: pressed ? 0.6 : 1 })}
              >
                <Icon icon={SparklesIcon} tone="accentInk" size={13} />
                <Text style={{ color: colors.accentInk, fontSize: 14, fontWeight: "600" }}>Fix in Chat</Text>
              </Pressable>
            </>
          )}
        </View>
      )}
      {!!error && <Text style={{ color: colors.red, fontSize: 13 }}>{error}</Text>}
    </View>
  );
}

/** Comments on the PR and its review threads as cards, newest or oldest first; resolved threads behind a toggle. */
export function PrComments({
  pr,
  client,
  cwd,
  newestFirst,
  onOpenFile,
}: Omit<Base, "number"> & { pr: PullRequestDetail; newestFirst: boolean; onOpenFile: (path: string) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [showResolved, setShowResolved] = useState(false);
  const { items, resolved } = commentItems(pr, newestFirst);
  const thread = (entry: PullRequestThread) => (
    <ThreadCard key={entry.id} client={client} cwd={cwd} pr={pr} thread={entry} showPath onOpenFile={() => onOpenFile(entry.path)} />
  );
  return (
    <View style={{ gap: 10 }}>
      {!items.length && !resolved.length && <Text style={[styles.muted, { paddingHorizontal: 4 }]}>No comments yet.</Text>}
      {items.map((item) =>
        item.type === "comment" ? <CommentCard key={item.comment.id} comment={item.comment} client={client} cwd={cwd} /> : thread(item.thread),
      )}
      {resolved.length > 0 && (
        <Pressable accessibilityRole="button" onPress={() => setShowResolved((value) => !value)} style={{ paddingVertical: 8, paddingHorizontal: 4 }}>
          <Text style={{ color: colors.accentInk, fontSize: 14, fontWeight: "600" }}>
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </Text>
        </Pressable>
      )}
      {showResolved && resolved.map(thread)}
    </View>
  );
}

/** The comments on their own page: where the composer's review pill lands. */
export function PrThreads({ onOpenFile, ...base }: Base & { onOpenFile: (path: string) => void }) {
  const { pr, error, refresh } = usePrDetail(base.client, base.cwd, base.number);
  if (!pr) return <Waiting error={error} retry={refresh} />;
  return (
    <PageScroll>
      <PrComments client={base.client} cwd={base.cwd} pr={pr} newestFirst onOpenFile={onOpenFile} />
    </PageScroll>
  );
}

/** The PR's files under their folders, each with its counts and open threads; a file opens its diff. */
export function FileList({ pr, onOpenFile }: { pr: PullRequestDetail; onOpenFile: (file: PullRequestFile) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const threads = new Map<string, number>();
  for (const thread of openThreadsOf(pr)) threads.set(thread.path, (threads.get(thread.path) ?? 0) + 1);
  return (
    <View style={{ gap: 12 }}>
      {filesByFolder(pr.files).map(({ folder, files }) => (
        <View key={folder} style={{ gap: 6 }}>
          {!!folder && (
            <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.caption, { paddingHorizontal: 4, fontFamily: fonts.mono }]}>
              {folder}
            </Text>
          )}
          <View style={[styles.card, { padding: 0, gap: 0 }]}>
            {files.map((file, index) => (
              <View key={file.path}>
                {index > 0 && <Separator />}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${fileName(file.path)}, ${file.additions} added, ${file.deletions} removed`}
                  onPress={() => {
                    tap();
                    onOpenFile(file);
                  }}
                  style={({ pressed }) => ({
                    minHeight: 48,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    opacity: pressed ? 0.55 : 1,
                  })}
                >
                  <Text numberOfLines={1} ellipsizeMode="middle" style={{ flex: 1, color: colors.ink, fontSize: 15 }}>
                    {fileName(file.path)}
                  </Text>
                  {threads.has(file.path) && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                      <Icon icon={BubbleChatIcon} tone="orange" size={13} />
                      <Text style={{ color: colors.orange, fontSize: 12 }}>{threads.get(file.path)}</Text>
                    </View>
                  )}
                  <Text style={{ fontFamily: fonts.mono, fontSize: 12 }}>
                    <Text style={{ color: colors.add }}>+{file.additions}</Text> <Text style={{ color: colors.remove }}>−{file.deletions}</Text>
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

const PickSeparator = () => <Separator inset={40} />;

type PickItem = { id: string; title: string; subtitle?: string; color?: string; team?: boolean; checked: boolean; disabled?: boolean };

/**
 * Labels or reviewers, searchable, each a toggle written to GitHub at once: the PR shows the change straight away and the
 * read after the write confirms it.
 */
export function PrPicker({ client, cwd, number, kind }: Base & { kind: "labels" | "reviewers" }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { pr, error: readError, refresh } = usePrDetail(client, cwd, number);
  const labels = useRpc<RepoLabelsResult>(kind === "labels" ? client : null, "pr:labels", [{ cwd }]);
  const people = useRpc<ReviewerCandidatesResult>(kind === "reviewers" ? client : null, "pr:reviewer-candidates", [{ cwd }]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  if (!pr) return <Waiting error={readError} retry={refresh} />;
  const list = kind === "labels" ? labels : people;
  const failure = list.error || (list.data && !list.data.ok ? list.data.message : "");
  const known = labels.data?.ok ? labels.data.labels : [];
  const items: PickItem[] =
    kind === "labels"
      ? [
          ...known.map((label) => ({
            id: label.name,
            title: label.name,
            subtitle: label.description || undefined,
            color: label.color,
            checked: pr.labels.some((entry) => entry.name === label.name),
          })),
          // A label on the PR the repository's list no longer has still shows, to take it off.
          ...pr.labels
            .filter((label) => !known.some((entry) => entry.name === label.name))
            .map((label) => ({ id: label.name, title: label.name, color: label.color, checked: true })),
        ]
      : [
          ...pr.reviewers.map((reviewer) => ({
            id: reviewer.login,
            title: reviewer.login,
            subtitle: VERDICT[reviewer.state].label,
            team: reviewer.team,
            checked: true,
            // GitHub can only take back a request; a review once given stays.
            disabled: reviewer.state !== "REQUESTED",
          })),
          ...(people.data?.ok ? people.data.logins : [])
            .filter((login) => login !== pr.author && !pr.reviewers.some((reviewer) => reviewer.login === login))
            .map((login) => ({ id: login, title: login, checked: false })),
        ];
  const search = query.trim().toLowerCase();
  const shown = items.filter((item) => item.title.toLowerCase().includes(search));
  async function toggle(item: PickItem) {
    tap();
    const add = item.checked ? [] : [item.id];
    const remove = item.checked ? [item.id] : [];
    const result =
      kind === "labels"
        ? await writePr(client, cwd, number, "pr:set-labels", { add, remove }, (current) => withLabels(current, add, remove, known))
        : await writePr(client, cwd, number, "pr:request-reviewers", { add, remove }, (current) => withReviewers(current, add, remove));
    setError(result.ok ? "" : result.message);
  }
  return (
    <FlatList
      data={shown}
      keyExtractor={(item) => item.id}
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
      ListHeaderComponent={
        <View style={{ paddingTop: 12, paddingBottom: 8, gap: 10 }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={kind === "labels" ? "Search labels" : "Search people"}
            placeholderTextColor={colors.ink3}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            accessibilityLabel={kind === "labels" ? "Search labels" : "Search people"}
            style={styles.input}
          />
          {!!(error || failure) && <ErrorNotice message={error || failure} retry={error ? undefined : list.refresh} retryTitle="Try again" />}
          {list.loading && <ActivityIndicator color={colors.ink3} />}
        </View>
      }
      ItemSeparatorComponent={PickSeparator}
      ListEmptyComponent={
        list.loading ? undefined : (
          <Text style={[styles.muted, { paddingVertical: 24, textAlign: "center" }]}>{kind === "labels" ? "No labels." : "No one to ask."}</Text>
        )
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={item.subtitle ? `${item.title}. ${item.subtitle}` : item.title}
          accessibilityState={{ checked: item.checked, disabled: item.disabled }}
          disabled={item.disabled}
          onPress={() => void toggle(item)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            minHeight: 52,
            paddingHorizontal: 6,
            paddingVertical: 10,
            borderRadius: 10,
            borderCurve: "continuous",
            backgroundColor: pressed ? colors.hover : "transparent",
            opacity: item.disabled ? 0.5 : 1,
          })}
        >
          <View style={{ width: 22, alignItems: "center" }}>
            {kind === "labels" ? (
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: `#${item.color}` }} />
            ) : (
              <Avatar login={item.id} size={22} team={item.team} />
            )}
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: colors.ink, fontSize: 15 }}>{item.title}</Text>
            {!!item.subtitle && (
              <Text numberOfLines={1} style={styles.caption}>
                {item.subtitle}
              </Text>
            )}
          </View>
          <View style={{ width: 18 }}>{item.checked && <Icon icon={Tick02Icon} tone="accent" size={18} />}</View>
        </Pressable>
      )}
    />
  );
}

/** Submit the review: a verdict (the author can only comment), a summary, and the draft comments already added. */
export function PrReviewForm({ client, cwd, number, onDone }: Base & { onDone: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { pr, error: readError, refresh } = usePrDetail(client, cwd, number);
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!pr) return <Waiting error={readError} retry={refresh} />;
  const pending = pr.pendingReview?.count ?? 0;
  const options = pr.viewerIsAuthor
    ? [{ value: "COMMENT", title: "Comment" }]
    : [
        { value: "COMMENT", title: "Comment" },
        { value: "APPROVE", title: "Approve" },
        { value: "REQUEST_CHANGES", title: "Request changes" },
      ];
  async function submit() {
    setBusy(true);
    setError("");
    const result = await writePr(client, cwd, number, "pr:submit-review", { event, body });
    setBusy(false);
    if (result.ok) {
      patchDetail(cwd, number, (current) => ({ ...current, pendingReview: null }));
      onDone();
    } else setError(result.message);
  }
  return (
    <PageScroll contentContainerStyle={{ gap: 16 }}>
      {options.length > 1 && <Segmented label="Review verdict" value={event} options={options} onChange={(value) => setEvent(value as ReviewEvent)} />}
      <TextInput
        multiline
        value={body}
        onChangeText={setBody}
        placeholder={event === "APPROVE" ? "Add a note (optional)" : "Leave a comment"}
        placeholderTextColor={colors.ink3}
        style={[styles.input, { minHeight: 120, textAlignVertical: "top" }]}
      />
      <Text style={styles.caption}>
        {pending
          ? `${pending} draft ${pending === 1 ? "comment goes" : "comments go"} with this review.`
          : pr.viewerIsAuthor
            ? "You opened this PR, so GitHub only lets you comment on it."
            : "Long-press a line in a diff to add comments to this review."}
      </Text>
      {!!error && <Text style={{ color: colors.red, fontSize: 14 }}>{error}</Text>}
      <WideButton
        title={event === "APPROVE" ? "Approve" : event === "REQUEST_CHANGES" ? "Request changes" : "Submit review"}
        busy={busy}
        disabled={event !== "APPROVE" && !pending && !body.trim()}
        onPress={() => void submit()}
      />
    </PageScroll>
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

function WideButton({ title, onPress, disabled = false, busy = false }: { title: string; onPress: () => void; disabled?: boolean; busy?: boolean }) {
  const { colors } = useTheme();
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
        backgroundColor: colors.ink,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      {busy && <ActivityIndicator color={colors.onInk} />}
      <Text style={{ color: colors.onInk, fontSize: 17, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}

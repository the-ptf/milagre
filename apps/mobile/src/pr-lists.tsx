import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as Linking from "expo-linking";
import { CancelCircleIcon, CheckmarkCircle02Icon, CircleIcon, Loading03Icon, MinusSignCircleIcon, BubbleChatIcon } from "@hugeicons/core-free-icons";
import type { PullRequestCheck, PullRequestDetail, PullRequestFile, PullRequestThread, ReviewEvent } from "@milagre/shared/pull-request-review";
import type { Client } from "./client";
import { Icon } from "./icons";
import { Markdown } from "./markdown";
import { ErrorNotice, PageScroll, Segmented, tap, useStyles } from "./ui";
import { fonts, useTheme } from "./theme";
import { usePrDetail, writePr, patchDetail } from "./pr-store";
import { sendToChat } from "./pr-chat";
import { Avatar, FixButton, Separator, SmallButton, WideButton } from "./pr-overview";
import { checkMessage, fileName, filesByFolder, openThreadsOf, threadMessage, viewedCount, withResolved, withViewed } from "./pr-review";

type Base = { client: Client; cwd: string; number: number; chatKey?: string; onChat: () => void };

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

const OUTCOME = {
  fail: { icon: CancelCircleIcon, tone: "red", label: "Failed" },
  running: { icon: Loading03Icon, tone: "orange", label: "Running" },
  pass: { icon: CheckmarkCircle02Icon, tone: "green", label: "Passed" },
  skipped: { icon: MinusSignCircleIcon, tone: "ink3", label: "Skipped" },
  neutral: { icon: CircleIcon, tone: "ink3", label: "Neutral" },
} as const;

/** Every check on the PR's head, failing first; a failure goes to the Chat with Fix in Chat. */
export function PrChecks({ client, cwd, number, chatKey, onChat }: Base) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { pr, error, refresh } = usePrDetail(client, cwd, number);
  if (!pr) return <Waiting error={error} retry={refresh} />;
  return (
    <PageScroll contentContainerStyle={{ gap: 12 }}>
      <View style={[styles.card, { padding: 0, gap: 0 }]}>
        {pr.checks.map((check: PullRequestCheck, index) => {
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
                {check.outcome === "fail" ? (
                  <FixButton
                    onPress={() =>
                      void sendToChat(chatKey, checkMessage(pr, check)).then((sent) => {
                        if (sent !== "unavailable") onChat();
                        return sent;
                      })
                    }
                  />
                ) : (
                  <Text style={styles.caption}>{outcome.label}</Text>
                )}
              </Pressable>
            </View>
          );
        })}
      </View>
    </PageScroll>
  );
}

/** One review thread: its comments, then Reply, Resolve and Fix in Chat. Draft comments say so and can be deleted. */
export function ThreadCard({
  thread,
  pr,
  client,
  cwd,
  chatKey,
  onChat,
  showPath = false,
  onOpenFile,
}: Base & { thread: PullRequestThread; pr: PullRequestDetail; showPath?: boolean; onOpenFile?: () => void }) {
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
    <View
      style={{
        borderRadius: 14,
        borderCurve: "continuous",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: drafts ? colors.accent : colors.lineStrong,
        backgroundColor: colors.surface,
        padding: 12,
        gap: 10,
        opacity: thread.resolved ? 0.7 : 1,
      }}
    >
      {showPath && (
        <Pressable accessibilityRole="button" disabled={!onOpenFile} onPress={onOpenFile}>
          <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: colors.accentInk, fontSize: 12, fontFamily: fonts.mono }}>
            {thread.path}
            {thread.line ? `:${thread.line}` : ""}
          </Text>
        </Pressable>
      )}
      {thread.comments.map((comment) => (
        <View key={comment.id} style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Avatar login={comment.author} />
            <Text style={{ color: colors.ink, fontSize: 14, fontWeight: "600" }}>{comment.author}</Text>
            {comment.pending && <Text style={{ color: colors.accentInk, fontSize: 12, fontWeight: "600" }}>Pending</Text>}
            <View style={{ flex: 1 }} />
            {comment.pending ? (
              <SmallButton title="Delete" tone="red" onPress={() => void write("pr:delete-comment", { commentId: comment.id })} />
            ) : thread.resolved ? (
              <Text style={styles.caption}>Resolved</Text>
            ) : thread.outdated ? (
              <Text style={styles.caption}>Outdated</Text>
            ) : null}
          </View>
          <Markdown text={comment.body} />
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
          <View style={{ flex: 1 }} />
          {!thread.resolved && (
            <FixButton
              onPress={() =>
                void sendToChat(chatKey, threadMessage(pr, thread)).then((sent) => {
                  if (sent !== "unavailable") onChat();
                  else setError("Open this PR's Chat to send that.");
                  return sent;
                })
              }
            />
          )}
        </View>
      )}
      {!!error && <Text style={{ color: colors.red, fontSize: 13 }}>{error}</Text>}
    </View>
  );
}

const VERDICT_LABEL = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  COMMENTED: "Commented",
  REQUESTED: "Review requested",
  DISMISSED: "Dismissed",
} as const;

/** Reviewers and their verdicts, then the open threads (each with Fix in Chat), then the resolved ones. */
export function PrThreads({ onOpenFile, ...base }: Base & { onOpenFile: (path: string) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { pr, error, refresh } = usePrDetail(base.client, base.cwd, base.number);
  const [showResolved, setShowResolved] = useState(false);
  if (!pr) return <Waiting error={error} retry={refresh} />;
  const open = openThreadsOf(pr);
  const drafts = pr.threads.filter((thread) => !thread.resolved && thread.comments.every((comment) => comment.pending));
  const resolved = pr.threads.filter((thread) => thread.resolved);
  return (
    <PageScroll contentContainerStyle={{ gap: 14 }}>
      {pr.reviewers.length > 0 && (
        <View style={[styles.card, { gap: 10 }]}>
          {pr.reviewers.map((reviewer) => (
            <View key={reviewer.login} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Avatar login={reviewer.login} size={24} />
              <Text style={{ flex: 1, color: colors.ink, fontSize: 15 }}>{reviewer.login}</Text>
              <Text
                style={{
                  color: reviewer.state === "APPROVED" ? colors.green : reviewer.state === "CHANGES_REQUESTED" ? colors.orange : colors.ink3,
                  fontSize: 13,
                  opacity: reviewer.stale ? 0.6 : 1,
                }}
              >
                {VERDICT_LABEL[reviewer.state]}
                {reviewer.stale ? " · before the latest push" : ""}
              </Text>
            </View>
          ))}
        </View>
      )}
      {pr.comments.length > 0 && (
        <View style={{ gap: 10 }}>
          <Text style={[styles.section, { paddingHorizontal: 4 }]}>Conversation</Text>
          {pr.comments.map((comment) => (
            <View key={comment.id} style={[styles.card, { gap: 6, padding: 12 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Avatar login={comment.author} />
                <Text style={{ color: colors.ink, fontSize: 14, fontWeight: "600" }}>{comment.author}</Text>
              </View>
              <Markdown text={comment.body} />
            </View>
          ))}
        </View>
      )}
      {[...open, ...drafts].length === 0 && resolved.length === 0 && (
        <Text style={[styles.muted, { textAlign: "center", paddingVertical: 24 }]}>No review threads on this PR.</Text>
      )}
      {[...open, ...drafts].map((thread) => (
        <ThreadCard key={thread.id} {...base} pr={pr} thread={thread} showPath onOpenFile={() => onOpenFile(thread.path)} />
      ))}
      {resolved.length > 0 && (
        <Pressable accessibilityRole="button" onPress={() => setShowResolved((value) => !value)} style={{ paddingVertical: 8, paddingHorizontal: 4 }}>
          <Text style={{ color: colors.accentInk, fontSize: 14, fontWeight: "600" }}>
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </Text>
        </Pressable>
      )}
      {showResolved &&
        resolved.map((thread) => <ThreadCard key={thread.id} {...base} pr={pr} thread={thread} showPath onOpenFile={() => onOpenFile(thread.path)} />)}
    </PageScroll>
  );
}

/** The PR's files under their folders, each with its counts and a Viewed check; a file opens its diff. */
export function PrFiles({
  client,
  cwd,
  number,
  onOpenFile,
  header,
}: Omit<Base, "chatKey" | "onChat"> & { onOpenFile: (file: PullRequestFile) => void; header?: React.ReactNode }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { pr, error, refresh } = usePrDetail(client, cwd, number);
  if (!pr) return <Waiting error={error} retry={refresh} />;
  const { viewed, total } = viewedCount(pr.files);
  const threads = new Map<string, number>();
  for (const thread of openThreadsOf(pr)) threads.set(thread.path, (threads.get(thread.path) ?? 0) + 1);
  function toggle(file: PullRequestFile) {
    const next = file.viewed !== "VIEWED";
    void writePr(client, cwd, number, "pr:file-viewed", { path: file.path, viewed: next }, (current) => withViewed(current, file.path, next));
  }
  return (
    <PageScroll contentContainerStyle={{ gap: 12 }}>
      {header}
      <View style={{ gap: 8, paddingHorizontal: 4 }}>
        <Text style={styles.caption}>
          {viewed} of {total} viewed
        </Text>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: "hidden" }}>
          <View style={{ width: `${total ? (viewed / total) * 100 : 0}%`, height: 4, backgroundColor: colors.green }} />
        </View>
      </View>
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
                <View style={{ flexDirection: "row", alignItems: "center", minHeight: 48 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${fileName(file.path)}, ${file.additions} added, ${file.deletions} removed${file.viewed === "VIEWED" ? ", viewed" : ""}`}
                    onPress={() => {
                      tap();
                      onOpenFile(file);
                    }}
                    style={({ pressed }) => ({
                      flex: 1,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      paddingLeft: 16,
                      paddingVertical: 12,
                      opacity: pressed ? 0.55 : 1,
                    })}
                  >
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="middle"
                      style={{ flex: 1, color: file.viewed === "VIEWED" ? colors.ink3 : colors.ink, fontSize: 15 }}
                    >
                      {fileName(file.path)}
                    </Text>
                    {threads.has(file.path) && <Icon icon={BubbleChatIcon} tone="orange" size={13} />}
                    <Text style={{ fontFamily: fonts.mono, fontSize: 12 }}>
                      <Text style={{ color: colors.add }}>+{file.additions}</Text> <Text style={{ color: colors.remove }}>−{file.deletions}</Text>
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel={`Viewed ${fileName(file.path)}`}
                    accessibilityState={{ checked: file.viewed === "VIEWED" }}
                    hitSlop={6}
                    onPress={() => {
                      tap();
                      toggle(file);
                    }}
                    style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}
                  >
                    <Icon
                      icon={file.viewed === "VIEWED" ? CheckmarkCircle02Icon : CircleIcon}
                      tone={file.viewed === "VIEWED" ? "green" : file.viewed === "DISMISSED" ? "orange" : "ink3"}
                      size={20}
                    />
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}
    </PageScroll>
  );
}

/** Submit the review: a verdict (the author can only comment), a summary, and the draft comments already added. */
export function PrReviewForm({ client, cwd, number, onDone }: Omit<Base, "chatKey" | "onChat"> & { onDone: () => void }) {
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

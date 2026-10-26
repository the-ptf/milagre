import { memo, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowLeft01Icon, ArrowRight01Icon, CheckmarkCircle02Icon, CircleIcon } from "@hugeicons/core-free-icons";
import type { DiffLine } from "@milagre/shared/diff-parse";
import type { Range } from "@milagre/shared/diff-layout";
import type { DiffFileResult, DiffFilesResult } from "@milagre/shared/git-diff";
import type { PullRequestThread } from "@milagre/shared/pull-request-review";
import type { Client } from "./client";
import { useScreenActive } from "./display-clock";
import { useRpc } from "./use-rpc";
import { LARGE_DIFF_LINES, diffRows, wordSegments, type DiffRow } from "./diff-rows";
import { Counts, StatusBox } from "./diff-ui";
import { Icon } from "./icons";
import { ErrorNotice, PillButton, tap, useStyles } from "./ui";
import { fonts, useTheme } from "./theme";
import { usePrDetail, writePr } from "./pr-store";
import { sendToChat } from "./pr-chat";
import { ThreadCard } from "./pr-lists";
import { SmallButton } from "./pr-overview";
import { attachThreads, fileName, lineMessage, lineTarget, neighbours, splitDiffRows, withViewed, type SplitDiffRow } from "./pr-review";

const MARKER = { add: "+", remove: "−", context: "" } as const;
/** Wide enough to show old and new side by side (an iPad, a phone in landscape stays unified). */
const SPLIT_WIDTH = 700;

type Composer = { after: string; line: number; side: "LEFT" | "RIGHT" };
type Item =
  | { type: "row"; row: DiffRow | SplitDiffRow }
  | { type: "thread"; key: string; thread: PullRequestThread }
  | { type: "composer"; key: string; composer: Composer };

export type PrDiffProps = {
  client: Client;
  cwd: string;
  number: number;
  path: string;
  chatKey?: string;
  onChat: () => void;
  /** Another file of the PR: previous, next. */
  onNavigate: (path: string) => void;
  onReview: () => void;
};

/**
 * A PR file's diff as GitHub computes it, with the review threads under their lines. Long-press a line to comment on it:
 * the comment joins your draft review, or goes to the Chat instead. Side by side where the screen is wide.
 */
export function PrDiff({ client, cwd, number, path, chatKey, onChat, onNavigate, onReview }: PrDiffProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const active = useScreenActive();
  const { pr, error: readError, refresh: reread } = usePrDetail(client, cwd, number, active);
  const [width, setWidth] = useState(0);
  const [forced, setForced] = useState(false);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [notice, setNotice] = useState("");
  const file = pr?.files.find((entry) => entry.path === path);
  const commits = pr ? { base: pr.baseRefOid, head: pr.headRefOid } : null;
  const large = !!file && file.additions + file.deletions > LARGE_DIFF_LINES && !forced;
  const { data: listed } = useRpc<DiffFilesResult | { ok: false; message: string }>(commits ? client : null, "pr:diff-files", [{ cwd, ...commits }], false);
  const entry = listed && "isRepo" in listed && listed.isRepo ? listed.files.find((item) => item.path === path) : undefined;
  const listedDone = !!listed;
  const {
    data: result,
    error,
    refresh,
  } = useRpc<DiffFileResult | { ok: false; message: string }>(
    commits && listedDone && !large && !entry?.binary ? client : null,
    "pr:diff-file",
    [{ cwd, ...commits, path, ...(entry?.oldPath ? { oldPath: entry.oldPath } : {}) }],
    active,
  );
  const patch = result && "patch" in result ? result.patch : "";
  const split = width >= SPLIT_WIDTH;
  const threads = useMemo(() => (pr ? pr.threads.filter((thread) => thread.path === path) : []), [pr, path]);
  const attached = useMemo(() => {
    const rows = patch ? (split ? splitDiffRows(patch) : diffRows(patch)) : [];
    return attachThreads<DiffRow | SplitDiffRow>(rows, threads);
  }, [patch, split, threads]);
  const items: Item[] = useMemo(() => {
    if (!composer) return attached.items;
    const index = attached.items.findIndex((item) => item.type === "row" && item.row.key === composer.after);
    if (index === -1) return attached.items;
    let at = index + 1;
    while (attached.items[at]?.type === "thread") at++;
    return [...attached.items.slice(0, at), { type: "composer" as const, key: `c:${composer.after}`, composer }, ...attached.items.slice(at)];
  }, [attached, composer]);

  if (!pr) return readError ? <ErrorNotice message={readError} retry={reread} retryTitle="Try again" /> : null;
  const { index, previous, next } = neighbours(pr.files, path);
  const viewed = file?.viewed === "VIEWED";
  const failure = result && !("patch" in result) ? result.message : error;
  const emptyNote =
    entry?.binary || (result && "binary" in result && result.binary)
      ? "This is a binary file. Review it on your computer."
      : large
        ? `This file changes ${(file?.additions ?? 0) + (file?.deletions ?? 0)} lines.`
        : result && "tooLarge" in result && result.tooLarge
          ? "This diff is over 1 MB. Review it on your computer."
          : result && "patch" in result && !patch
            ? (listed && "isRepo" in listed && listed.message) || "No diff for this file."
            : "";

  function comment(line: DiffLine | undefined, key: string) {
    const target = line && lineTarget(line);
    if (!target) return;
    tap();
    setComposer({ after: key, ...target });
  }

  const header = (
    <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {file && <StatusBox status={file.status} />}
        <Text selectable numberOfLines={2} ellipsizeMode="middle" style={[styles.caption, { flex: 1 }]}>
          {path}
        </Text>
        {file && <Counts added={file.additions} removed={file.deletions} />}
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel="Viewed"
          accessibilityState={{ checked: viewed }}
          hitSlop={6}
          onPress={() => {
            tap();
            void writePr(client, cwd, number, "pr:file-viewed", { path, viewed: !viewed }, (current) => withViewed(current, path, !viewed));
          }}
          style={({ pressed }) => ({
            height: 30,
            paddingHorizontal: 10,
            borderRadius: 15,
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            backgroundColor: viewed ? colors.greenTint : colors.hover,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Icon icon={viewed ? CheckmarkCircle02Icon : CircleIcon} tone={viewed ? "green" : "ink2"} size={14} />
          <Text style={{ color: viewed ? colors.green : colors.ink2, fontSize: 13, fontWeight: "600" }}>Viewed</Text>
        </Pressable>
      </View>
      {attached.detached.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={styles.caption}>Not on this diff</Text>
          {attached.detached.map((thread) => (
            <ThreadCard key={thread.id} client={client} cwd={cwd} number={number} chatKey={chatKey} onChat={onChat} pr={pr} thread={thread} />
          ))}
        </View>
      )}
      {!!notice && <Text style={[styles.caption, { color: colors.accentInk }]}>{notice}</Text>}
    </View>
  );

  return (
    <View style={{ flex: 1 }} onLayout={({ nativeEvent }) => setWidth(Math.round(nativeEvent.layout.width))}>
      {failure ? (
        <View style={{ padding: 16, gap: 12 }}>
          {header}
          <ErrorNotice message={failure} retry={refresh} retryTitle="Try again" />
        </View>
      ) : emptyNote ? (
        <View>
          {header}
          <View style={{ alignItems: "center", gap: 12, paddingVertical: 32, paddingHorizontal: 24 }}>
            <Text style={[styles.muted, { textAlign: "center" }]}>{emptyNote}</Text>
            {large && <PillButton title="Show diff" secondary onPress={() => setForced(true)} />}
          </View>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => (item.type === "row" ? item.row.key : item.key)}
          renderItem={({ item }) =>
            item.type === "row" ? (
              item.row.type === "pair" ? (
                <PairRow row={item.row} onComment={comment} />
              ) : (
                <UnifiedRow row={item.row} onComment={comment} />
              )
            ) : item.type === "thread" ? (
              <View style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.inset }}>
                <ThreadCard client={client} cwd={cwd} number={number} chatKey={chatKey} onChat={onChat} pr={pr} thread={item.thread} />
              </View>
            ) : (
              <LineComposer
                composer={item.composer}
                onCancel={() => setComposer(null)}
                onChat={(text) =>
                  void sendToChat(chatKey, lineMessage(pr, path, item.composer.line, item.composer.side, text)).then((outcome) => {
                    if (outcome === "unavailable") setNotice("Open this PR's Chat to send that.");
                    else {
                      setComposer(null);
                      onChat();
                    }
                    return outcome;
                  })
                }
                onReview={async (text) => {
                  const written = await writePr(client, cwd, number, "pr:comment", { path, line: item.composer.line, side: item.composer.side, body: text });
                  if (written.ok) {
                    setComposer(null);
                    setNotice("Added to your review.");
                  }
                  return written.ok ? "" : written.message;
                }}
              />
            )
          }
          ListHeaderComponent={header}
          ListEmptyComponent={<Text style={[styles.muted, { textAlign: "center", paddingVertical: 32 }]}>Reading diff…</Text>}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 96 }}
          initialNumToRender={60}
          windowSize={11}
        />
      )}
      <View pointerEvents="box-none" style={{ position: "absolute", left: 16, right: 16, bottom: 20 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            padding: 6,
            borderRadius: 28,
            borderCurve: "continuous",
            backgroundColor: colors.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.lineStrong,
          }}
        >
          <NavButton
            label={previous ? `Previous file, ${fileName(previous.path)}` : "No previous file"}
            icon={ArrowLeft01Icon}
            disabled={!previous}
            onPress={() => previous && onNavigate(previous.path)}
          />
          <Text style={{ flex: 1, textAlign: "center", color: colors.ink2, fontSize: 14, fontVariant: ["tabular-nums"] }}>
            File {index + 1} of {pr.files.length}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Review${pr.pendingReview?.count ? `, ${pr.pendingReview.count} pending` : ""}`}
            onPress={onReview}
            style={({ pressed }) => ({
              height: 40,
              paddingHorizontal: 14,
              borderRadius: 20,
              justifyContent: "center",
              backgroundColor: colors.hover2,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ color: colors.ink, fontSize: 14, fontWeight: "600" }}>
              {pr.pendingReview?.count ? `${pr.pendingReview.count} pending` : "Review"}
            </Text>
          </Pressable>
          <NavButton
            label={next ? `Next file, ${fileName(next.path)}` : "No next file"}
            icon={ArrowRight01Icon}
            disabled={!next}
            onPress={() => next && onNavigate(next.path)}
          />
        </View>
      </View>
    </View>
  );
}

function NavButton({ label, icon, disabled, onPress }: { label: string; icon: typeof ArrowLeft01Icon; disabled: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.hover,
        opacity: disabled ? 0.35 : pressed ? 0.6 : 1,
      })}
    >
      <Icon icon={icon} tone="ink" size={18} />
    </Pressable>
  );
}

function useCode() {
  const { colors, codeSize } = useTheme();
  const code = { fontFamily: fonts.mono, fontSize: codeSize, lineHeight: Math.round(codeSize * 1.5) } as const;
  return {
    colors,
    code,
    tint: { add: colors.diffAdd, remove: colors.diffRemove, context: "transparent" } as const,
    word: { add: colors.diffAddWord, remove: colors.diffRemoveWord, context: "transparent" } as const,
    marker: { add: colors.add, remove: colors.remove, context: colors.ink3 } as const,
  };
}

function Hunk({ header }: { header: string }) {
  const { colors, code } = useCode();
  return (
    <Text numberOfLines={1} style={[code, { fontSize: 11, color: colors.ink3, backgroundColor: colors.inset, paddingHorizontal: 12, paddingVertical: 3 }]}>
      {header}
    </Text>
  );
}

function Words({ text, words, kind }: { text: string; words: Range[]; kind: DiffLine["kind"] }) {
  const { word } = useCode();
  return (
    <>
      {wordSegments(text, words).map((part, index) => (
        <Text key={index} style={part.changed ? { backgroundColor: word[kind] } : undefined}>
          {part.text}
        </Text>
      ))}
      {text ? "" : " "}
    </>
  );
}

const UnifiedRow = memo(function UnifiedRow({ row, onComment }: { row: DiffRow; onComment: (line: DiffLine, key: string) => void }) {
  const { colors, code, tint, marker } = useCode();
  if (row.type === "hunk") return <Hunk header={row.header} />;
  const { line, words } = row;
  const number = line.kind === "remove" ? line.oldNumber : line.newNumber;
  return (
    <Pressable
      accessibilityLabel={`${line.kind === "add" ? "Added" : line.kind === "remove" ? "Removed" : "Line"} ${number}: ${line.text}`}
      accessibilityHint="Long-press to comment on this line"
      onLongPress={() => onComment(line, row.key)}
      delayLongPress={350}
      style={({ pressed }) => ({ flexDirection: "row", backgroundColor: pressed ? colors.hover : tint[line.kind] })}
    >
      <Text style={[code, { width: 40, paddingRight: 6, textAlign: "right", color: colors.ink3, fontVariant: ["tabular-nums"] }]}>{number}</Text>
      <Text style={[code, { width: 14, textAlign: "center", color: marker[line.kind] }]}>{MARKER[line.kind]}</Text>
      <Text style={[code, { flex: 1, paddingRight: 12, color: colors.ink }]}>
        <Words text={line.text} words={words} kind={line.kind} />
      </Text>
    </Pressable>
  );
});

function Half({ line, words, onComment, rowKey }: { line?: DiffLine; words: Range[]; onComment: (line: DiffLine, key: string) => void; rowKey: string }) {
  const { colors, code, tint } = useCode();
  if (!line) return <View style={{ flex: 1, backgroundColor: colors.inset }} />;
  const number = line.kind === "remove" ? line.oldNumber : line.newNumber;
  return (
    <Pressable
      accessibilityLabel={`${line.kind === "add" ? "Added" : line.kind === "remove" ? "Removed" : "Line"} ${number}: ${line.text}`}
      accessibilityHint="Long-press to comment on this line"
      onLongPress={() => onComment(line, rowKey)}
      delayLongPress={350}
      style={({ pressed }) => ({ flex: 1, flexDirection: "row", backgroundColor: pressed ? colors.hover : tint[line.kind] })}
    >
      <Text style={[code, { width: 40, paddingRight: 6, textAlign: "right", color: colors.ink3, fontVariant: ["tabular-nums"] }]}>{number}</Text>
      <Text style={[code, { flex: 1, paddingRight: 8, color: colors.ink }]}>
        <Words text={line.text} words={words} kind={line.kind} />
      </Text>
    </Pressable>
  );
}

const PairRow = memo(function PairRow({ row, onComment }: { row: SplitDiffRow; onComment: (line: DiffLine, key: string) => void }) {
  const { colors } = useCode();
  if (row.type === "hunk") return <Hunk header={row.header} />;
  return (
    <View style={{ flexDirection: "row" }}>
      <Half line={row.left} words={row.leftWords} onComment={onComment} rowKey={row.key} />
      <View style={{ width: StyleSheet.hairlineWidth, backgroundColor: colors.line }} />
      <Half line={row.right} words={row.rightWords} onComment={onComment} rowKey={row.key} />
    </View>
  );
});

/** A comment on one line: into your draft review on GitHub, or to the Chat instead. */
function LineComposer({
  composer,
  onCancel,
  onChat,
  onReview,
}: {
  composer: Composer;
  onCancel: () => void;
  onChat: (text: string) => void;
  onReview: (text: string) => Promise<string>;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 8, backgroundColor: colors.inset }}>
      <Text style={styles.caption}>{composer.side === "LEFT" ? `Old line ${composer.line}` : `Line ${composer.line}`}</Text>
      <TextInput
        autoFocus
        multiline
        value={text}
        onChangeText={setText}
        placeholder="Comment on this line"
        placeholderTextColor={colors.ink3}
        style={[styles.input, { minHeight: 72, fontSize: 15, textAlignVertical: "top", borderWidth: 1, borderColor: colors.accent }]}
      />
      {!!error && <Text style={{ color: colors.red, fontSize: 13 }}>{error}</Text>}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <SmallButton title="Cancel" tone="ink2" onPress={onCancel} />
        <View style={{ flex: 1 }} />
        <SmallButton title="Send to Chat" disabled={!text.trim()} onPress={() => onChat(text)} />
        <SmallButton
          title="Add to review"
          filled
          busy={busy}
          disabled={!text.trim()}
          onPress={() => {
            setBusy(true);
            void onReview(text).then((message) => {
              setBusy(false);
              setError(message);
              return message;
            });
          }}
        />
      </View>
    </View>
  );
}

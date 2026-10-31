import { useScreenActive } from "../display-clock";
import { memo, useMemo, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import { commitComparisonLabel, type DiffFileEntry, type DiffFileResult } from "@milagre/shared/git-diff";
import { useSession } from "../session";
import { memberForDiff } from "../chat-scope";
import { useRpc } from "../use-rpc";
import { LARGE_DIFF_LINES, diffRows, wordSegments, type DiffRow } from "../diff-rows";
import { Counts, StatusBox } from "../diff-ui";
import { ErrorNotice, PillButton, useStyles } from "../ui";
import { fonts, useTheme } from "../theme";

const MARKER = { add: "+", remove: "−", context: "" } as const;
const codeStyle = (size: number) => ({ fontFamily: fonts.mono, fontSize: size, lineHeight: Math.round(size * 1.5) }) as const;

export type DiffTarget = {
  worktreeId: string;
  memberId?: string;
  path: string;
  oldPath?: string;
  untracked?: string;
  binary?: string;
  mode: string;
  base?: string;
  commit?: string;
  /** Empty string identifies a root commit; omission supports older hosts. */
  commitParent?: string;
  status?: DiffFileEntry["status"];
  added?: string;
  removed?: string;
};

export default function Diff() {
  const styles = useStyles();
  const params = useLocalSearchParams<DiffTarget>();
  const session = useSession();
  if (!session.client || !memberForDiff(session.snapshot?.project, Number(params.worktreeId), params.memberId)) return <Redirect href="/" />;
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: params.path.split("/").pop() || params.path }} />
      <DiffView target={params} />
    </View>
  );
}

/** Desktop's DiffFile, unified: hunk headers, one line-number gutter, +/− markers, row tints and changed-word highlights. */
export function DiffView({ target }: { target: DiffTarget }) {
  const styles = useStyles();
  const session = useSession();
  const worktree = memberForDiff(session.snapshot?.project, Number(target.worktreeId), target.memberId);
  const { path, oldPath, untracked, mode, base, commit } = target;
  const added = Number(target.added || 0);
  const removed = Number(target.removed || 0);
  const [forced, setForced] = useState(false);
  const large = added + removed > LARGE_DIFF_LINES && !forced;
  const skip = !worktree || large || target.binary === "1";
  const active = useScreenActive();
  const {
    data: result,
    error,
    refresh,
  } = useRpc<DiffFileResult>(
    skip ? null : session.client,
    "git:diff-file",
    [{ cwd: worktree?.path, path, oldPath, untracked: untracked === "1", mode, base, commit }],
    active,
  );
  const patch = result?.patch;
  const rows = useMemo(() => (patch ? diffRows(patch) : []), [patch]);
  if (!worktree) return null;
  const notice =
    target.binary === "1" || result?.binary
      ? "This is a binary file. Review it on your computer."
      : large
        ? `This file changes ${added + removed} lines.`
        : result?.tooLarge
          ? "This diff is over 1 MB. Review it on your computer."
          : result && !rows.length
            ? "No diff remains for this file. Pull to refresh Changes."
            : "";
  const header = (
    <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 6 }}>
      {commit && (
        <Text style={styles.caption}>
          Commit {commit.slice(0, 8)} · {commitComparisonLabel(target.commitParent === "" ? null : target.commitParent)}
        </Text>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {target.status && <StatusBox status={target.status} />}
        <Text selectable numberOfLines={2} ellipsizeMode="middle" style={[styles.caption, { flex: 1 }]}>
          {oldPath ? `${oldPath} → ${path}` : path}
        </Text>
        {target.binary !== "1" && <Counts added={added} removed={removed} />}
      </View>
    </View>
  );
  return error ? (
    <View style={{ padding: 16 }}>
      {header}
      <ErrorNotice message={error} retry={refresh} />
    </View>
  ) : notice ? (
    <View>
      {header}
      <View style={{ alignItems: "center", gap: 12, paddingVertical: 32, paddingHorizontal: 24 }}>
        <Text style={[styles.muted, { textAlign: "center" }]}>{notice}</Text>
        {large && <PillButton title="Show diff" secondary onPress={() => setForced(true)} />}
      </View>
    </View>
  ) : (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={({ item }) => <Row row={item} />}
      ListHeaderComponent={header}
      ListEmptyComponent={<Text style={[styles.muted, { textAlign: "center", paddingVertical: 32 }]}>Reading diff…</Text>}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 40 }}
      initialNumToRender={60}
      windowSize={11}
    />
  );
}

const Row = memo(function Row({ row }: { row: DiffRow }) {
  const { colors, codeSize } = useTheme();
  const code = codeStyle(codeSize);
  const TINT = { add: colors.diffAdd, remove: colors.diffRemove, context: "transparent" } as const;
  const WORD = { add: colors.diffAddWord, remove: colors.diffRemoveWord, context: "transparent" } as const;
  const MARKER_COLOR = { add: colors.add, remove: colors.remove, context: colors.ink3 } as const;
  if (row.type === "hunk")
    return (
      <Text numberOfLines={1} style={[code, { fontSize: 11, color: colors.ink3, backgroundColor: colors.inset, paddingHorizontal: 12, paddingVertical: 3 }]}>
        {row.header}
      </Text>
    );
  const { line, words } = row;
  const number = line.kind === "remove" ? line.oldNumber : line.newNumber;
  return (
    <View
      accessible
      accessibilityLabel={`${line.kind === "add" ? "Added" : line.kind === "remove" ? "Removed" : "Line"} ${number}: ${line.text}`}
      style={{ flexDirection: "row", backgroundColor: TINT[line.kind] }}
    >
      <Text style={[code, { width: 40, paddingRight: 6, textAlign: "right", color: colors.ink3, fontVariant: ["tabular-nums"] }]}>{number}</Text>
      <Text style={[code, { width: 14, textAlign: "center", color: MARKER_COLOR[line.kind] }]}>{MARKER[line.kind]}</Text>
      <Text style={[code, { flex: 1, paddingRight: 12, color: colors.ink }]}>
        {wordSegments(line.text, words).map((part, index) => (
          <Text key={index} style={part.changed ? { backgroundColor: WORD[line.kind] } : undefined}>
            {part.text}
          </Text>
        ))}
        {line.text ? "" : " "}
      </Text>
    </View>
  );
});

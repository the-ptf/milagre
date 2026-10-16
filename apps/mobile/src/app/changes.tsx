import React, { useMemo, useState } from "react";
import { RefreshControl, Text, View } from "react-native";
import { Redirect, Stack, router, useLocalSearchParams } from "expo-router";
import type { DiffFileEntry, DiffFilesResult, DiffMode } from "@milagre/shared/git-diff";
import { buildDiffTree } from "@milagre/shared/diff-tree";
import type { DiffTarget } from "./diff";
import { useSession } from "../session";
import { useRpc } from "../use-rpc";
import { Counts } from "../diff-ui";
import { ChangeTree as Tree } from "../change-tree";
import { LinkChangesView } from "../link-changes";
import { ErrorNotice, PageScroll, Segmented, useStyles } from "../ui";

const MODES = [
  { value: "uncommitted", title: "Uncommitted" },
  { value: "committed", title: "Committed" },
];

/** Desktop's ChangesPanel as a page; the side panels show the same view over a Chat. */
export default function Changes() {
  const { worktreeId } = useLocalSearchParams<{ worktreeId: string }>();
  const session = useSession();
  if (!session.client || !session.snapshot?.project.state.worktrees[Number(worktreeId)]) return <Redirect href="/" />;
  return (
    <>
      <Stack.Screen options={{ title: "Changes" }} />
      <ChangesView worktreeId={Number(worktreeId)} />
    </>
  );
}

export function ChangesView(props: { worktreeId: number; header?: React.ReactNode; onOpen?: (target: DiffTarget) => void }) {
  const session = useSession();
  return session.snapshot?.project.link ? (
    <LinkChangesView chatId={props.worktreeId} header={props.header} onOpen={props.onOpen} />
  ) : (
    <ProjectChangesView {...props} />
  );
}

/** The Worktree's changed files as a folder tree with counts and status boxes; a file opens its diff, as a page unless `onOpen` shows it. */
function ProjectChangesView({ worktreeId, header, onOpen }: { worktreeId: number; header?: React.ReactNode; onOpen?: (target: DiffTarget) => void }) {
  const styles = useStyles();
  const session = useSession();
  const worktree = session.snapshot?.project.state.worktrees[worktreeId];
  const [mode, setMode] = useState<DiffMode>("uncommitted");
  const [refreshing, setRefreshing] = useState(false);
  const {
    data: result,
    error,
    refresh,
  } = useRpc<DiffFilesResult>(worktree ? session.client : null, "git:diff-files", [{ cwd: worktree?.path, base: worktree?.base, mode }]);
  const files = result?.isRepo ? result.files : undefined;
  const tree = useMemo(() => buildDiffTree(files ?? []), [files]);
  if (!worktree) return null;
  const added = files?.reduce((sum, file) => sum + file.added, 0) ?? 0;
  const removed = files?.reduce((sum, file) => sum + file.removed, 0) ?? 0;
  const base = result?.isRepo ? result.base : null;
  const open = (file: DiffFileEntry) => {
    const target: DiffTarget = {
      worktreeId: String(worktreeId),
      mode,
      path: file.path,
      status: file.status,
      added: String(file.added),
      removed: String(file.removed),
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      untracked: file.untracked ? "1" : "0",
      binary: file.binary ? "1" : "0",
      ...(base ? { base } : {}),
    };
    if (onOpen) onOpen(target);
    else router.push({ pathname: "/diff", params: target });
  };
  const empty = !result
    ? "Reading changes…"
    : !result.isRepo
      ? result.message
      : mode === "committed" && base === null
        ? "No base branch to compare with."
        : files?.length
          ? ""
          : result.message || (mode === "uncommitted" ? "No uncommitted changes." : "Nothing committed since the base branch.");
  return (
    <PageScroll
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            refresh();
            setTimeout(() => setRefreshing(false), 400);
          }}
        />
      }
      contentContainerStyle={{ gap: 12 }}
    >
      {header}
      <Segmented label="Changes mode" value={mode} options={MODES} onChange={(value) => setMode(value as DiffMode)} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
        <Text numberOfLines={1} style={[styles.caption, { flex: 1 }]}>
          {worktree.name}
          {mode === "committed" && base ? ` · since ${base}` : ""}
        </Text>
        {!!files?.length && <Counts added={added} removed={removed} size={13} />}
      </View>
      {error ? (
        <ErrorNotice message={error} retry={refresh} />
      ) : empty ? (
        <Text style={[styles.muted, { textAlign: "center", paddingVertical: 32 }]}>{empty}</Text>
      ) : (
        <View style={[styles.card, { paddingVertical: 4, paddingHorizontal: 0, gap: 0 }]}>
          <Tree nodes={tree} depth={0} onOpen={open} />
        </View>
      )}
    </PageScroll>
  );
}

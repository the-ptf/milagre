import React, { useState } from "react";
import { RefreshControl, Text } from "react-native";
import { Redirect, Stack, router, useLocalSearchParams } from "expo-router";
import type { DiffTarget } from "./diff";
import { useSession } from "../session";
import { ChangeSections, diffTarget } from "../change-tree";
import { LinkChangesView } from "../link-changes";
import { PageScroll, useStyles } from "../ui";

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

/** The Worktree's changed files as folder trees, not committed then on this branch; a file opens its diff, as a page unless `onOpen` shows it. */
function ProjectChangesView({ worktreeId, header, onOpen }: { worktreeId: number; header?: React.ReactNode; onOpen?: (target: DiffTarget) => void }) {
  const styles = useStyles();
  const session = useSession();
  const worktree = session.snapshot?.project.state.worktrees[worktreeId];
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  if (!worktree) return null;
  return (
    <PageScroll
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            setRevision((value) => value + 1);
            setTimeout(() => setRefreshing(false), 400);
          }}
        />
      }
      contentContainerStyle={{ gap: 12 }}
    >
      {header}
      <Text numberOfLines={1} style={[styles.caption, { paddingHorizontal: 4 }]}>
        {worktree.name}
      </Text>
      <ChangeSections
        revision={revision}
        client={session.client}
        cwd={worktree.path}
        base={worktree.base}
        onOpen={(file, mode, base, commit, commitParent) => {
          const target = diffTarget(file, mode, base, { worktreeId: String(worktreeId) }, commit, commitParent);
          if (onOpen) onOpen(target);
          else router.push({ pathname: "/diff", params: target });
        }}
      />
    </PageScroll>
  );
}

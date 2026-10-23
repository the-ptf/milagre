import { useScreenActive } from "./display-clock";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { router } from "expo-router";
import { ArrowDown01Icon, ArrowRight01Icon, GitBranchIcon } from "@hugeicons/core-free-icons";
import type { WorktreeBinding } from "@milagre/shared/model";
import { LINK_PENDING_WORKTREE_TEXT } from "@milagre/shared/worktree-link";
import type { DiffFileEntry, DiffFilesResult, DiffMode } from "@milagre/shared/git-diff";
import { buildDiffTree } from "@milagre/shared/diff-tree";
import type { DiffTarget } from "./app/diff";
import { useSession } from "./session";
import { useRpc } from "./use-rpc";
import { Counts } from "./diff-ui";
import { ChangeTree } from "./change-tree";
import { ProjectIcon } from "./project-icon";
import { Icon } from "./icons";
import { ErrorNotice, PageScroll, Segmented, useStyles } from "./ui";
import { useTheme } from "./theme";

export function LinkChangesView({ chatId, header, onOpen }: { chatId: number; header?: React.ReactNode; onOpen?: (target: DiffTarget) => void }) {
  const styles = useStyles();
  const session = useSession();
  const link = session.snapshot?.project.link;
  const members = link?.state.sessions[chatId]?.worktrees ?? [];
  const [mode, setMode] = useState<DiffMode>("uncommitted");
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  return (
    <PageScroll
      contentContainerStyle={{ gap: 12 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            setRevision((value) => value + 1);
            void session.refresh().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {header}
      <Segmented
        label="Changes mode"
        value={mode}
        options={[
          { value: "uncommitted", title: "Uncommitted" },
          { value: "committed", title: "Committed" },
        ]}
        onChange={(value) => setMode(value as DiffMode)}
      />

      {members.map((member) => (
        <MemberChanges
          key={`${member.projectId}:${revision}`}
          member={member}
          name={link?.projects.find((project) => project.id === member.projectId)?.name ?? "Project"}
          chatId={chatId}
          mode={mode}
          onOpen={onOpen}
        />
      ))}
      {link?.projects
        .filter((project) => !members.some((member) => member.projectId === project.id))
        .map((project) => (
          <View
            key={project.id}
            accessible
            accessibilityLabel={`${project.name}. ${LINK_PENDING_WORKTREE_TEXT}`}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12, paddingLeft: 26, paddingRight: 4 }}
          >
            <ProjectIcon client={session.client} path={project.path} />
            <View style={{ flex: 1, gap: 5 }}>
              <Text numberOfLines={1} style={[styles.text, { fontSize: 16, fontWeight: "500" }]}>
                {project.name}
              </Text>
              <Text style={styles.caption}>{LINK_PENDING_WORKTREE_TEXT}</Text>
            </View>
          </View>
        ))}
    </PageScroll>
  );
}

function MemberChanges({
  member,
  name,
  chatId,
  mode,
  onOpen,
}: {
  member: WorktreeBinding;
  name: string;
  chatId: number;
  mode: DiffMode;
  onOpen?: (target: DiffTarget) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const [collapsed, setCollapsed] = useState(false);
  const active = useScreenActive();
  const {
    data: result,
    error,
    refresh,
  } = useRpc<DiffFilesResult>(session.client, "git:diff-files", [{ cwd: member.worktreePath, base: member.base, mode }], active);
  const files = result?.isRepo ? result.files : undefined;
  const tree = useMemo(() => buildDiffTree(files ?? []), [files]);
  const added = files?.reduce((sum, file) => sum + file.added, 0) ?? 0;
  const removed = files?.reduce((sum, file) => sum + file.removed, 0) ?? 0;
  const base = result?.isRepo ? result.base : null;
  const open = (file: DiffFileEntry) => {
    const target: DiffTarget = {
      worktreeId: String(chatId),
      memberId: member.projectId,
      path: file.path,
      mode,
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
    ? "Reading changes..."
    : !result.isRepo
      ? result.message
      : mode === "committed" && base === null
        ? "No base branch to compare with."
        : files?.length
          ? ""
          : result.message || (mode === "uncommitted" ? "No uncommitted changes." : "Nothing committed since the base branch.");
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${name}`}
        accessibilityState={{ expanded: !collapsed }}
        onPress={() => setCollapsed((value) => !value)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 12,
          paddingHorizontal: 4,
          borderRadius: 12,
          backgroundColor: pressed ? colors.hover : "transparent",
        })}
      >
        <Icon icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon} tone="ink3" size={14} />
        <ProjectIcon client={session.client} path={member.projectPath} />
        <View style={{ flex: 1, gap: 5 }}>
          <Text numberOfLines={1} style={[styles.text, { fontSize: 16, fontWeight: "500" }]}>
            {name}
          </Text>
          <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
            <Icon icon={GitBranchIcon} tone="ink3" size={12} />
            <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.caption, { flex: 1 }]}>
              {member.branch}
            </Text>
          </View>
        </View>
        <Counts added={added} removed={removed} size={13} />
      </Pressable>
      {!collapsed &&
        (error ? (
          <ErrorNotice message={error} retry={refresh} />
        ) : empty ? (
          <Text style={[styles.muted, { padding: 12 }]}>{empty}</Text>
        ) : (
          <View style={[styles.card, { paddingHorizontal: 0, paddingVertical: 4, gap: 0 }]}>
            <ChangeTree nodes={tree} depth={0} onOpen={open} />
          </View>
        ))}
    </View>
  );
}

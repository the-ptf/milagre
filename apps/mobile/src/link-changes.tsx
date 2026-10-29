import { useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { router } from "expo-router";
import { ArrowDown01Icon, ArrowRight01Icon, GitBranchIcon } from "@hugeicons/core-free-icons";
import type { WorktreeBinding } from "@milagre/shared/model";
import { LINK_PENDING_WORKTREE_TEXT } from "@milagre/shared/worktree-link";
import type { DiffTarget } from "./app/diff";
import { useSession } from "./session";
import { ChangeSections, diffTarget } from "./change-tree";
import { ProjectIcon } from "./project-icon";
import { Icon } from "./icons";
import { PageScroll, useStyles } from "./ui";
import { useTheme } from "./theme";

export function LinkChangesView({ chatId, header, onOpen }: { chatId: number; header?: React.ReactNode; onOpen?: (target: DiffTarget) => void }) {
  const styles = useStyles();
  const session = useSession();
  const link = session.snapshot?.project.link;
  const members = link?.state.sessions[chatId]?.worktrees ?? [];
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

      {members.map((member) => (
        <MemberChanges
          key={member.projectId}
          revision={revision}
          member={member}
          name={link?.projects.find((project) => project.id === member.projectId)?.name ?? "Project"}
          chatId={chatId}
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
  revision,
  onOpen,
}: {
  member: WorktreeBinding;
  name: string;
  chatId: number;
  revision: number;
  onOpen?: (target: DiffTarget) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const [collapsed, setCollapsed] = useState(false);
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
      </Pressable>
      {!collapsed && (
        <ChangeSections
          client={session.client}
          cwd={member.worktreePath}
          base={member.base}
          revision={revision}
          onOpen={(file, mode, base, commit, commitParent) => {
            const target = diffTarget(file, mode, base, { worktreeId: String(chatId), memberId: member.projectId }, commit, commitParent);
            if (onOpen) onOpen(target);
            else router.push({ pathname: "/diff", params: target });
          }}
        />
      )}
    </View>
  );
}

import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ArrowDown01Icon, ArrowRight01Icon, File01Icon } from "@hugeicons/core-free-icons";
import type { DiffFileEntry, DiffFilesResult, DiffMode } from "@milagre/shared/git-diff";
import { buildDiffTree, type DiffTreeNode } from "@milagre/shared/diff-tree";
import type { Client } from "./client";
import type { DiffTarget } from "./app/diff";
import { useScreenActive } from "./display-clock";
import { useRpc } from "./use-rpc";
import { Icon } from "./icons";
import { Counts, StatusBox } from "./diff-ui";
import { ErrorNotice, useStyles } from "./ui";
import { useTheme } from "./theme";

function ChangeTree({ nodes, depth, onOpen }: { nodes: DiffTreeNode<DiffFileEntry>[]; depth: number; onOpen: (file: DiffFileEntry) => void }) {
  return (
    <>
      {nodes.map((node) => (
        <TreeRow key={node.path} node={node} depth={depth} onOpen={onOpen} />
      ))}
    </>
  );
}

function TreeRow({ node, depth, onOpen }: { node: DiffTreeNode<DiffFileEntry>; depth: number; onOpen: (file: DiffFileEntry) => void }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [collapsed, setCollapsed] = useState(false);
  const row = { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingLeft: 12 + depth * 14, paddingRight: 14 } as const;
  if (node.type === "file")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${node.name}, ${node.file.status}`}
        onPress={() => onOpen(node.file)}
        style={({ pressed }) => [row, { backgroundColor: pressed ? colors.hover : "transparent" }]}
      >
        <Icon icon={File01Icon} tone="ink3" size={16} strokeWidth={1.6} />
        <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.text, { flex: 1, fontSize: 15 }]}>
          {node.name}
        </Text>
        {!node.file.binary && <Counts added={node.file.added} removed={node.file.removed} />}
        <StatusBox status={node.file.status} />
      </Pressable>
    );
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${node.name} folder`}
        accessibilityState={{ expanded: !collapsed }}
        onPress={() => setCollapsed((value) => !value)}
        style={({ pressed }) => [row, { backgroundColor: pressed ? colors.hover : "transparent" }]}
      >
        <Icon icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon} tone="ink3" size={15} />
        <Text numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, color: colors.ink2, fontSize: 15 }}>
          {node.name}
        </Text>
        <Counts added={node.added} removed={node.removed} />
      </Pressable>
      {!collapsed && <ChangeTree nodes={node.children} depth={depth + 1} onOpen={onOpen} />}
    </>
  );
}

const SECTIONS: { mode: DiffMode; title: string }[] = [
  { mode: "uncommitted", title: "Not committed" },
  { mode: "committed", title: "On this branch" },
];

/**
 * A Worktree's changes as one list: what isn't committed yet, then what the branch committed since its base. An empty
 * section hides, as on desktop.
 */
export function ChangeSections({
  client,
  cwd,
  base,
  revision = 0,
  onOpen,
}: {
  client: Client | null;
  cwd: string;
  base?: string;
  /** Bumped by pull-to-refresh: both lists read again, keeping their folders as they are. */
  revision?: number;
  onOpen: (file: DiffFileEntry, mode: DiffMode, base: string | null) => void;
}) {
  const styles = useStyles();
  const active = useScreenActive();
  const uncommitted = useRpc<DiffFilesResult>(client, "git:diff-files", [{ cwd, base, mode: "uncommitted" }], active);
  const committed = useRpc<DiffFilesResult>(client, "git:diff-files", [{ cwd, base, mode: "committed" }], active);
  const reads = { uncommitted, committed };
  const [read, setRead] = useState(revision);
  if (read !== revision) {
    setRead(revision);
    uncommitted.refresh();
    committed.refresh();
  }
  const shown = SECTIONS.flatMap(({ mode, title }) => {
    const result = reads[mode].data;
    return result?.isRepo && result.files.length ? [{ mode, title, files: result.files, base: result.base }] : [];
  });
  // A list that can't be read says so above the one that could.
  const failed = SECTIONS.filter(({ mode }) => reads[mode].error);
  const notice = failed[0] ? <ErrorNotice message={reads[failed[0].mode].error} retry={() => failed.forEach(({ mode }) => reads[mode].refresh())} /> : null;
  if (!shown.length) {
    if (notice) return notice;
    const done = uncommitted.data && committed.data;
    const notRepo = uncommitted.data && !uncommitted.data.isRepo ? uncommitted.data.message : "";
    return <Text style={[styles.muted, { textAlign: "center", paddingVertical: 32 }]}>{!done ? "Reading changes…" : notRepo || "No changes."}</Text>;
  }
  return (
    <>
      {notice}
      {shown.map((section) => (
        <View key={section.mode} style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
            <Text numberOfLines={1} style={[styles.label, { flex: 1 }]}>
              {section.title}
              {section.mode === "committed" && section.base ? <Text style={styles.caption}>{` since ${section.base}`}</Text> : null}
            </Text>
            <Counts
              added={section.files.reduce((sum, file) => sum + file.added, 0)}
              removed={section.files.reduce((sum, file) => sum + file.removed, 0)}
              size={13}
            />
          </View>
          <View style={[styles.card, { paddingVertical: 4, paddingHorizontal: 0, gap: 0 }]}>
            <ChangeTree nodes={buildDiffTree(section.files)} depth={0} onOpen={(file) => onOpen(file, section.mode, section.base)} />
          </View>
        </View>
      ))}
    </>
  );
}

/** The file's diff address: the mode and base it was listed under. */
export function diffTarget(file: DiffFileEntry, mode: DiffMode, base: string | null, where: { worktreeId: string; memberId?: string }): DiffTarget {
  return {
    ...where,
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
}

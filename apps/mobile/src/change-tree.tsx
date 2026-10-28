import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ArrowDown01Icon, ArrowRight01Icon, File01Icon } from "@hugeicons/core-free-icons";
import { isGitHistoryUnavailable, type DiffFileEntry, type DiffFilesResult, type DiffMode, type GitHistory, type GitCommit } from "@milagre/shared/git-diff";
import { buildDiffTree, type DiffTreeNode } from "@milagre/shared/diff-tree";
import type { Client } from "./client";
import type { DiffTarget } from "./app/diff";
import { showChoiceSheet } from "./choice-store";
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
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [view, setView] = useState<"files" | "commits">("files");
  const [limit, setLimit] = useState(0);
  const selected = choices[cwd] ?? "";
  const comparisonBase = selected || base;
  const history = useRpc<GitHistory>(client, "git:history", [{ cwd, base: comparisonBase, limit }], active, JSON.stringify([cwd, comparisonBase]));
  const unavailable = isGitHistoryUnavailable(history.error);
  const data = history.data?.isRepo ? history.data : undefined;
  const uncommitted = useRpc<DiffFilesResult>(client, "git:diff-files", [{ cwd, base, mode: "uncommitted" }], active);
  const committed = useRpc<DiffFilesResult>(client, "git:diff-files", [{ cwd, base: comparisonBase, mode: "committed" }], active);
  const reads = { uncommitted, committed };
  const [read, setRead] = useState(revision);
  if (read !== revision) {
    setRead(revision);
    uncommitted.refresh();
    committed.refresh();
    history.refresh();
  }
  const shown = SECTIONS.flatMap(({ mode, title }) => {
    const result = reads[mode].data;
    return result?.isRepo && result.files.length ? [{ mode, title, files: result.files, base: result.base }] : [];
  });
  // A list that can't be read says so above the one that could.
  const failed = SECTIONS.filter(({ mode }) => reads[mode].error);
  const notice = failed[0] ? <ErrorNotice message={reads[failed[0].mode].error} retry={() => failed.forEach(({ mode }) => reads[mode].refresh())} /> : null;
  const controls = unavailable ? null : (
    <View style={[styles.card, { gap: 10 }]}>
      <Text style={styles.label}>Branch: {data?.branch ?? (history.data ? "Detached HEAD" : "…")}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Comparison branch"
        onPress={() =>
          showChoiceSheet({
            title: "Compare with",
            placeholder: "Search branches",
            emptyLabel: "No branches",
            items: [
              { id: "automatic", title: "Automatic", subtitle: "Recorded base or project default", checked: !selected },
              ...(data?.branches ?? []).map((branch) => ({ id: branch.ref, title: branch.name, checked: selected === branch.ref })),
            ],
            onSelect: (value) => {
              setChoices((previous) => ({ ...previous, [cwd]: value === "automatic" ? "" : value }));
              setLimit(view === "commits" ? 30 : 0);
            },
          })
        }
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text style={styles.text}>Compare with: {selected.replace(/^refs\/(heads|remotes)\//, "") || `Automatic${data?.base ? ` (${data.base})` : ""}`}</Text>
      </Pressable>
      {data?.base && (
        <Text style={styles.caption}>
          Changes in {data.branch ?? "HEAD"} since {(data.comparisonRef ?? data.base).replace(/^refs\/(heads|remotes)\//, "")}
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 12 }}>
        {(["files", "commits"] as const).map((item) => (
          <Pressable
            key={item}
            accessibilityRole="button"
            accessibilityState={{ selected: view === item }}
            onPress={() => {
              setView(item);
              if (item === "commits") setLimit((value) => Math.max(value, 30));
            }}
            style={{ minHeight: 44, flex: 1, justifyContent: "center" }}
          >
            <Text style={view === item ? styles.label : styles.muted}>{item === "files" ? "Files" : "Commits"}</Text>
          </Pressable>
        ))}
      </View>
      {history.error ? <ErrorNotice message={history.error} retry={history.refresh} /> : null}
    </View>
  );
  if (view === "commits" && !unavailable)
    return (
      <>
        {controls}
        {!history.data && !history.error && <Text style={styles.muted}>Reading commits…</Text>}
        {data?.commits.map((commit) => (
          <CommitCard key={commit.sha} commit={commit} />
        ))}
        {data && !data.commits.length && (
          <Text style={styles.muted}>{history.loading ? "Reading commits…" : (data.message ?? "No commits since the comparison branch.")}</Text>
        )}
        {history.data && !history.data.isRepo && <Text style={styles.muted}>{history.data.message}</Text>}
        {data?.hasMore && limit < 300 && (
          <Pressable
            accessibilityRole="button"
            disabled={history.loading}
            onPress={() => setLimit((value) => Math.min(value + 30, 300))}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text style={styles.label}>Show more commits</Text>
          </Pressable>
        )}
        {data?.hasMore && limit >= 300 && (
          <Text style={styles.caption}>Showing the latest 300 commits. Choose a closer comparison branch to narrow the history.</Text>
        )}
      </>
    );
  if (!shown.length) {
    if (notice)
      return (
        <>
          {controls}
          {notice}
        </>
      );
    const done = uncommitted.data && committed.data;
    const notRepo = uncommitted.data && !uncommitted.data.isRepo ? uncommitted.data.message : "";
    const message = committed.data?.isRepo ? committed.data.message : undefined;
    return (
      <>
        {controls}
        <Text style={[styles.muted, { textAlign: "center", paddingVertical: 32 }]}>{!done ? "Reading changes…" : notRepo || message || "No changes."}</Text>
      </>
    );
  }
  return (
    <>
      {controls}
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
            <ChangeTree
              nodes={buildDiffTree(section.files)}
              depth={0}
              onOpen={(file) =>
                onOpen(file, section.mode, section.mode === "committed" ? (comparisonBase ?? data?.comparisonRef ?? section.base) : section.base)
              }
            />
          </View>
        </View>
      ))}
    </>
  );
}

function CommitCard({ commit }: { commit: GitCommit }) {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={[styles.card, { gap: 8 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text style={styles.label}>{commit.message.split("\n")[0]}</Text>
        <Text style={styles.caption}>
          {commit.author} · {new Date(commit.date).toLocaleString()}
        </Text>
      </Pressable>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={styles.muted}>{commit.files} files</Text>
        <Counts added={commit.added} removed={commit.removed} />
      </View>
      {expanded && (
        <>
          <Text selectable style={styles.text}>
            {commit.message}
          </Text>
          <Text selectable style={styles.caption}>
            {commit.author} &lt;{commit.email}&gt;
          </Text>
          <Text selectable style={styles.caption}>
            {commit.sha}
          </Text>
        </>
      )}
    </View>
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

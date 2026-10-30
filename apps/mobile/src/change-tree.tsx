import { createContext, useContext, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowLeft01Icon,
  File01Icon,
  GitBranchIcon,
  GitCommitIcon,
  CloudIcon,
  Cancel01Icon,
  Copy01Icon,
} from "@hugeicons/core-free-icons";
import * as Clipboard from "expo-clipboard";
import {
  branchName,
  comparisonBaseMissing,
  withHistoryBranches,
  commitStatsNotice,
  type GitBranchCatalog,
  commitInitials,
  comparisonOptions,
  isGitHistoryUnavailable,
  type DiffFileEntry,
  type DiffFilesResult,
  type DiffMode,
  type GitHistory,
  type GitCommit,
} from "@milagre/shared/git-diff";
import { buildDiffTree, type DiffTreeNode } from "@milagre/shared/diff-tree";
import type { Client } from "./client";
import type { DiffTarget } from "./app/diff";
import { showChoiceSheet } from "./choice-store";
import { useScreenActive } from "./display-clock";
import { useRpc } from "./use-rpc";
import { Icon } from "./icons";
import { Counts, StatusBox } from "./diff-ui";
import { UI_COPY } from "@milagre/shared/model-copy";
import { announce, Chip, EmptyState, ErrorNotice, pressStyle, useStyles } from "./ui";
import { lineHeight, radius, type } from "./design-tokens";
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
  const row = { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingLeft: 12 + depth * 16, paddingRight: 12 } as const;
  if (node.type === "file")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${node.name}, ${node.file.status}`}
        onPress={() => onOpen(node.file)}
        style={({ pressed }) => [row, { backgroundColor: pressed ? colors.hover : "transparent" }]}
      >
        <Icon icon={File01Icon} tone="ink3" size={16} />
        <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.text, { flex: 1, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }]}>
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
        <Icon icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon} tone="ink3" size={16} />
        <Text numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
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
 * False while the lists are mounted but out of sight (the right panel's Changes tab under its PR tab, or the panel
 * slid away): they stop reading the Mac every few seconds and read again as soon as they show.
 */
export const ChangesShownContext = createContext(true);

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
  const { colors } = useTheme();
  const screenActive = useScreenActive();
  const inSight = useContext(ChangesShownContext);
  const active = screenActive && inSight;
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [view, setView] = useState<"files" | "commits">("files");
  const [limit, setLimit] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const selected = choices[cwd] ?? "";
  const comparisonBase = selected || base;
  const [catalog, setCatalog] = useState<{ cwd: string; client: Client | null; value: GitBranchCatalog }>();
  const saved = catalog?.cwd === cwd && catalog.client === client ? catalog.value : undefined;
  const history = useRpc<GitHistory>(
    client,
    "git:history",
    [{ cwd, base: comparisonBase, recordedBase: base, branchesVersion: saved?.version, limit }],
    active,
    JSON.stringify([cwd, comparisonBase]),
  );
  const unavailable = isGitHistoryUnavailable(history.error);
  const response = history.data;
  if (response?.isRepo && response.branches && response.branchesVersion && saved?.version !== response.branchesVersion)
    setCatalog({ cwd, client, value: { version: response.branchesVersion, branches: response.branches } });
  const merged = response ? withHistoryBranches(response, saved) : undefined;
  const data = merged?.isRepo ? merged : undefined;
  const [missing, setMissing] = useState<{ cwd: string; client: Client | null; name: string }>();
  // Drop a deleted Git ref before rendering either list with a stale saved selection.
  if (active && selected && data && comparisonBaseMissing(data, selected)) {
    setChoices((previous) => ({ ...previous, [cwd]: "" }));
    setLimit(view === "commits" ? 30 : 0);
    setMissing({ cwd, client, name: branchName(selected) });
  }
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
  const fileCount = new Set(shown.flatMap((section) => section.files.map((file) => file.path))).size;
  const baseLabel = branchName(data?.comparisonRef || selected || data?.base || "Automatic");
  const current = data?.branch ?? data?.head?.slice(0, 8) ?? (history.data ? "HEAD" : "…");
  const controls = unavailable ? null : (
    <View style={{ borderBottomWidth: 1, borderColor: colors.line }}>
      <View onLayout={(event) => setNarrow(event.nativeEvent.layout.width < 300)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Comparison branch"
          accessibilityHint={`Compare with ${baseLabel}`}
          onPress={() =>
            showChoiceSheet({
              title: "Compare with",
              placeholder: "Search branches",
              emptyLabel: "No branches",
              items: comparisonOptions(data).map((option) => ({
                id: option.value || "automatic",
                title: option.label,
                subtitle: option.description,
                checked: selected === option.value,
                disabled: option.disabled,
                section: option.group,
                leading: <Icon icon={option.remote ? CloudIcon : GitBranchIcon} size={18} tone="ink3" />,
              })),
              onSelect: (value) => {
                setChoices((previous) => ({ ...previous, [cwd]: value === "automatic" ? "" : value }));
                setMissing(undefined);
                setLimit(view === "commits" ? 30 : 0);
              },
            })
          }
          style={({ pressed }) => [
            {
              minHeight: 44,
              maxWidth: "50%",
              flexShrink: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 12,
              borderRadius: radius.control,
              borderCurve: "continuous",
              backgroundColor: colors.hover,
            },
            pressStyle({ pressed }),
          ]}
        >
          <Icon icon={(data?.comparisonRef ?? selected).startsWith("refs/remotes/") ? CloudIcon : GitBranchIcon} size={16} tone="ink3" />
          <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.label, { flexShrink: 1 }]}>
            {baseLabel}
          </Text>
          <Icon icon={ArrowDown01Icon} size={12} tone="ink3" />
        </Pressable>
        {!narrow && <Icon icon={ArrowLeft01Icon} size={16} tone="ink3" />}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
          {!narrow && <Icon icon={data?.branch ? GitBranchIcon : GitCommitIcon} size={16} tone="ink3" />}
          <Text
            accessibilityLabel={`Current branch: ${data?.branch ?? `detached HEAD ${current}`}`}
            numberOfLines={1}
            ellipsizeMode="middle"
            style={[styles.caption, { flex: 1 }]}
          >
            {current}
          </Text>
          {data && !data.branch && <Text style={styles.caption}>detached</Text>}
        </View>
      </View>
      <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 8, paddingVertical: 8 }}>
        {(["files", "commits"] as const).map((item) => {
          const count = item === "files" ? fileCount : data?.total;
          return (
            <Chip
              key={item}
              role="tab"
              label={item === "files" ? "Files" : "Commits"}
              selected={view === item}
              trailing={
                count === undefined ? undefined : (
                  <Text
                    style={{
                      color: view === item ? colors.onInk : colors.ink3,
                      fontSize: type.caption1,
                      lineHeight: lineHeight.caption1,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {count}
                  </Text>
                )
              }
              onPress={() => {
                setView(item);
                if (item === "commits") setLimit((value) => Math.max(value, 30));
              }}
            />
          );
        })}
      </View>
      {missing?.cwd === cwd && missing.client === client && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text accessibilityRole="alert" style={[styles.caption, { flex: 1 }]}>
            {missing.name} no longer exists. {data?.base ? `Showing changes since ${data.base}.` : "Restoring the automatic base…"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss missing branch notice"
            onPress={() => setMissing(undefined)}
            style={({ pressed }) => [{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }, pressStyle({ pressed })]}
          >
            <Icon icon={Cancel01Icon} size={16} tone="ink3" />
          </Pressable>
        </View>
      )}
      {data?.message && (
        <View style={{ paddingVertical: 8 }}>
          <Text style={styles.caption}>{data.message}</Text>
          {data.projectDefault?.ref && data.projectDefault.ref !== data.comparisonRef && (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setMissing(undefined);
                setChoices((previous) => ({ ...previous, [cwd]: data.projectDefault!.ref! }));
                setLimit(view === "commits" ? 30 : 0);
              }}
              style={({ pressed }) => [{ minHeight: 44, justifyContent: "center" }, pressStyle({ pressed })]}
            >
              <Text style={styles.label}>Compare with {data.projectDefault.name} instead</Text>
            </Pressable>
          )}
        </View>
      )}
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
        {data && !data.commits.length && !data.message && (
          <Text style={styles.muted}>{history.loading ? "Reading commits…" : (data.message ?? "No commits since the comparison branch.")}</Text>
        )}
        {history.data && !history.data.isRepo && <Text style={styles.muted}>{history.data.message}</Text>}
        {data?.hasMore && limit < 300 && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: history.loading }}
            disabled={history.loading}
            onPress={() => setLimit((value) => Math.min(value + 30, 300))}
            style={({ pressed }) => [{ minHeight: 44, justifyContent: "center" }, pressStyle({ pressed, disabled: history.loading })]}
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
        {done ? (
          <EmptyState title={notRepo || UI_COPY.noChanges}>{notRepo ? undefined : message}</EmptyState>
        ) : (
          <Text style={[styles.muted, { textAlign: "center", paddingVertical: 32 }]}>Reading changes…</Text>
        )}
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
              {section.mode === "uncommitted" ? <Text style={styles.caption}> vs HEAD</Text> : null}
              {unavailable && section.mode === "committed" && section.base ? <Text style={styles.caption}>{` since ${section.base}`}</Text> : null}
            </Text>
            <Counts
              added={section.files.reduce((sum, file) => sum + file.added, 0)}
              removed={section.files.reduce((sum, file) => sum + file.removed, 0)}
              size={type.footnote}
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
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [copy, setCopy] = useState("Copy SHA");
  const copied = (ok: boolean) => {
    setCopy(ok ? "SHA copied" : "Copy failed. Retry");
    announce(ok ? "SHA copied" : "Copy failed");
  };
  return (
    <View style={{ borderBottomWidth: 1, borderColor: colors.line, paddingVertical: 12, gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [{ minHeight: 44, justifyContent: "center", gap: 6 }, pressStyle({ pressed })]}
      >
        <Text numberOfLines={expanded ? undefined : 2} style={styles.label}>
          {commit.message.split("\n")[0]}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View
            accessible={false}
            style={{ width: 20, height: 20, borderRadius: radius.full, backgroundColor: colors.hover, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={[styles.caption, { fontSize: type.caption2, lineHeight: lineHeight.caption2 }]}>{commitInitials(commit.author)}</Text>
          </View>
          <Text numberOfLines={1} style={[styles.caption, { flexShrink: 1 }]}>
            {commit.author}
          </Text>
          <Text style={styles.caption}>{new Date(commit.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</Text>
          {commit.statsUnavailable ? (
            <Text style={[styles.caption, { marginLeft: "auto" }]}>Totals unavailable</Text>
          ) : (
            <>
              <Text style={[styles.caption, { marginLeft: "auto" }]}>
                {commit.files} {commit.files === 1 ? "file" : "files"}
              </Text>
              <Counts added={commit.added} removed={commit.removed} />
            </>
          )}
        </View>
      </Pressable>
      {expanded && (
        <View style={{ borderLeftWidth: 2, borderColor: colors.line, paddingLeft: 12, gap: 8 }}>
          {commit.statsUnavailable && <Text style={styles.caption}>{commitStatsNotice(commit.statsUnavailable)}</Text>}
          <Text selectable style={styles.text}>
            {commit.message}
          </Text>
          <Text selectable style={styles.caption}>
            {commit.author} &lt;{commit.email}&gt; · {new Date(commit.date).toLocaleString()}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy}
            onPress={() =>
              void Clipboard.setStringAsync(commit.sha).then(
                (ok) => copied(ok),
                () => copied(false),
              )
            }
            style={({ pressed }) => [{ minHeight: 44, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 8 }, pressStyle({ pressed })]}
          >
            <Text selectable style={styles.caption}>
              {commit.sha.slice(0, 8)}
            </Text>
            <Icon icon={Copy01Icon} size={16} tone="ink3" />
            <Text style={styles.caption}>{copy}</Text>
          </Pressable>
        </View>
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

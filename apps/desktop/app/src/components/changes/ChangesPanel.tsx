import { useMemo, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon, Comment01Icon, File01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import type { DiffFileEntry, DiffMode } from "../../electron";
import { buildDiffTree, type DiffTreeNode } from "../../lib/diff-tree";
import Tooltip from "../primitives/Tooltip";
import { Select } from "../primitives/Select";
import type { DiffList } from "./useDiffFiles";
import { ScrollArea } from "../primitives/ScrollArea";

const MODES = [
  { value: "uncommitted" as const, label: "Uncommitted" },
  { value: "committed" as const, label: "Committed" },
];

const STATUS = {
  added: { letter: "A", label: "Added", className: "bg-green-tint text-diff-add" },
  deleted: { letter: "D", label: "Deleted", className: "bg-red-tint text-diff-remove" },
  modified: { letter: "M", label: "Modified", className: "bg-orange-tint text-orange" },
  renamed: { letter: "R", label: "Renamed", className: "bg-accent-tint text-accent-ink" },
} as const;

export function Counts({ added, removed, className = "", total = false }: { added: number; removed: number; className?: string; total?: boolean }) {
  return (
    <span data-diff-counts={total ? "total" : ""} className={`flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums ${className}`}>
      <span className="text-diff-add">+{added}</span>
      <span className="text-diff-remove">−{removed}</span>
    </span>
  );
}

export function StatusBox({ status }: { status: DiffFileEntry["status"] }) {
  const { letter, label, className } = STATUS[status];
  return (
    <span
      aria-label={label}
      data-status={letter}
      className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] font-semibold ${className}`}
    >
      {letter}
    </span>
  );
}

export function ChangesPanel({
  list,
  mode,
  onModeChange,
  onRefresh,
  onSelectFile,
  activePath,
  commentCounts,
}: {
  list: DiffList;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  onRefresh: () => void;
  onSelectFile: (path: string) => void;
  activePath?: string;
  /** Diff comments per file path. */
  commentCounts?: Record<string, number>;
}) {
  const files = list.state === "ready" && list.isRepo ? list.files : undefined;
  const added = files?.reduce((sum, file) => sum + file.added, 0) ?? 0;
  const removed = files?.reduce((sum, file) => sum + file.removed, 0) ?? 0;
  const base = list.state === "ready" && list.isRepo ? list.base : null;

  return (
    <aside
      data-changes-panel
      aria-label="Changes"
      className="flex min-h-0 w-[var(--changes-panel-width,320px)] shrink-0 flex-col overflow-hidden rounded-window bg-surface shadow-card"
    >
      <ChangesHeader
        mode={mode}
        onModeChange={onModeChange}
        onRefresh={onRefresh}
        loading={list.state === "loading"}
        totals={files?.length ? { added, removed } : undefined}
      >
        {mode === "committed" && base && (
          <span data-diff-base className="truncate px-0.5 text-[11px] text-ink-3">
            since <span className="font-mono">{base}</span>
          </span>
        )}
      </ChangesHeader>
      <ScrollArea className="flex-1 py-1.5">
        <ChangeList list={list} mode={mode} onSelectFile={onSelectFile} activePath={activePath} commentCounts={commentCounts} />
      </ScrollArea>
    </aside>
  );
}

/** Shared chrome for a Project's changes and a named Link's grouped changes. */
export function ChangesHeader({
  mode,
  onModeChange,
  onRefresh,
  loading,
  totals,
  children,
}: {
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  onRefresh: () => void;
  loading: boolean;
  totals?: { added: number; removed: number };
  children?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Select label="Changes mode" value={mode} options={MODES} onChange={onModeChange} width={180} />
        <span className="flex-1" />
        {totals && <Counts total {...totals} className="text-[12px]" />}
        <Tooltip label="Refresh changes" side="bottom" align="end">
          <button
            type="button"
            aria-label="Refresh changes"
            data-diff-refresh
            onClick={onRefresh}
            className="flex size-7 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-hover hover:text-ink"
          >
            <span className={loading ? "animate-spin" : ""}>
              <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.8} color="currentColor" />
            </span>
          </button>
        </Tooltip>
      </div>
      {children}
    </div>
  );
}

export function ChangeList({ list, mode, ...treeProps }: { list: DiffList; mode: DiffMode } & TreeProps) {
  const files = list.state === "ready" && list.isRepo ? list.files : undefined;
  const tree = useMemo(() => buildDiffTree(files ?? []), [files]);
  const base = list.state === "ready" && list.isRepo ? list.base : null;
  const message = list.state === "ready" && list.isRepo ? list.message : undefined;
  return (
    <>
      {list.state === "loading" && <Notice>Loading changes…</Notice>}
      {list.state === "error" && <Notice>{list.message}</Notice>}
      {list.state === "ready" && !list.isRepo && <Notice>{list.message}</Notice>}
      {list.state === "ready" && list.isRepo && mode === "committed" && base === null && <Notice>No base branch to compare with.</Notice>}
      {files && files.length === 0 && message && <Notice>{message}</Notice>}
      {files && files.length === 0 && !message && !(mode === "committed" && base === null) && (
        <Notice>{mode === "uncommitted" ? "No uncommitted changes." : "Nothing committed since the base branch."}</Notice>
      )}
      {files && files.length > 0 && <Tree nodes={tree} depth={0} {...treeProps} />}
    </>
  );
}

function Notice({ children }: { children: string }) {
  return <p className="px-4 py-6 text-center text-[12px] text-ink-3">{children}</p>;
}

type TreeProps = { onSelectFile: (path: string) => void; activePath?: string; commentCounts?: Record<string, number> };

function Tree({ nodes, depth, ...rest }: { nodes: DiffTreeNode<DiffFileEntry>[]; depth: number } & TreeProps) {
  return (
    <>
      {nodes.map((node) => (
        <TreeRow key={node.path} node={node} depth={depth} {...rest} />
      ))}
    </>
  );
}

function TreeRow({ node, depth, onSelectFile, activePath, commentCounts }: { node: DiffTreeNode<DiffFileEntry>; depth: number } & TreeProps) {
  const [collapsed, setCollapsed] = useState(false);
  const indent = { paddingLeft: 8 + depth * 12 };
  if (node.type === "file") {
    return (
      <button
        type="button"
        data-diff-tree-file={node.path}
        aria-current={activePath === node.path}
        onClick={() => onSelectFile(node.path)}
        style={indent}
        className={`flex h-7 w-full items-center gap-1.5 pr-3 text-left text-[12.5px] transition-colors hover:bg-hover ${activePath === node.path ? "bg-hover" : ""}`}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">
          <HugeiconsIcon icon={File01Icon} size={14} strokeWidth={1.6} color="currentColor" />
        </span>
        <span className="min-w-0 flex-1 truncate text-ink">{node.name}</span>
        {commentCounts?.[node.path] ? (
          <span
            data-diff-tree-comments={commentCounts[node.path]}
            aria-label={`${commentCounts[node.path]} comments`}
            className="flex shrink-0 items-center gap-0.5 text-[11px] text-ink-3 tabular-nums"
          >
            <HugeiconsIcon icon={Comment01Icon} size={12} strokeWidth={1.8} color="currentColor" />
            {commentCounts[node.path]}
          </span>
        ) : null}
        {!node.file.binary && <Counts added={node.file.added} removed={node.file.removed} />}
        <StatusBox status={node.file.status} />
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        data-diff-tree-folder={node.path}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        style={indent}
        className="flex h-7 w-full items-center gap-1.5 pr-3 text-left text-[12.5px] transition-colors hover:bg-hover"
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">
          <HugeiconsIcon icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon} size={13} strokeWidth={1.8} color="currentColor" />
        </span>
        <span className="min-w-0 flex-1 truncate text-ink-2" dir="rtl">
          <bdi>{node.name}</bdi>
        </span>
        <Counts added={node.added} removed={node.removed} />
      </button>
      {!collapsed && <Tree nodes={node.children} depth={depth + 1} onSelectFile={onSelectFile} activePath={activePath} commentCounts={commentCounts} />}
    </>
  );
}

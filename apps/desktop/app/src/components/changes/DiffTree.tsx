import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon, Comment01Icon, File01Icon } from "@hugeicons/core-free-icons";
import type { DiffFileEntry } from "../../electron";
import type { DiffTreeNode } from "../../lib/diff-tree";
import { Counts, StatusBox } from "./DiffIndicators";

export type TreeProps = { onSelectFile: (path: string) => void; activePath?: string; commentCounts?: Record<string, number> };

export function Tree({ nodes, depth, ...rest }: { nodes: DiffTreeNode<DiffFileEntry>[]; depth: number } & TreeProps) {
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
        className={`flex h-7 w-full items-center gap-1.5 pr-3 text-left text-13 transition-colors hover:bg-hover ${activePath === node.path ? "bg-hover" : ""}`}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">
          <HugeiconsIcon icon={File01Icon} size={14} strokeWidth={1.6} color="currentColor" />
        </span>
        <span className="min-w-0 flex-1 truncate text-ink">{node.name}</span>
        {commentCounts?.[node.path] ? (
          <span
            data-diff-tree-comments={commentCounts[node.path]}
            aria-label={`${commentCounts[node.path]} comments`}
            className="flex shrink-0 items-center gap-0.5 text-11 text-ink-3 tabular-nums"
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
        className="flex h-7 w-full items-center gap-1.5 pr-3 text-left text-13 transition-colors hover:bg-hover"
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">
          <HugeiconsIcon icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon} size={12} strokeWidth={1.8} color="currentColor" />
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

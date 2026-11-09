import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { fitFolder, shortestFolder } from "../../lib/fit-folder";
import Tooltip from "../primitives/Tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon, Comment01Icon, File01Icon } from "@hugeicons/core-free-icons";
import type { DiffFileEntry } from "../../electron";
import type { DiffTreeNode } from "../../lib/diff-tree";
import { Counts, STATUS_CELL, StatusBox } from "./DiffIndicators";

export type TreeProps = { onSelectFile: (path: string) => void; activePath?: string; commentCounts?: Record<string, number> };

/** Up to this many files a section lists them flat (name, then folder); more get the folder tree. */
export const FLAT_LIST_MAX = 10;

/**
 * A small change set as one flat list in a grid, so every row's folder starts at one x. The folder is shortened by whole
 * segments (fitFolder) to its room and the full path is the row's tooltip. At the panel's usual width an inline folder
 * column would get about 60px, too little for even "apps/mobile/…/hooks", so the folder sits under the name; from 440px
 * it takes its own column after the names.
 */
export function FlatList({ files, onSelectFile, activePath, commentCounts }: { files: DiffFileEntry[] } & TreeProps) {
  return (
    <div className="@container">
      {/* The outer 6px columns (plus the 6px gaps) are the rows' 12px insets: a subgrid row can't take padding of its own
          without its cells overrunning the shared tracks. */}
      <div
        data-diff-flat-list
        className="grid grid-cols-[6px_16px_minmax(0,1fr)_auto_auto_16px_6px] gap-x-1.5 @[440px]:grid-cols-[6px_16px_fit-content(45%)_minmax(0,1fr)_auto_auto_16px_6px]"
      >
        {files.map((file) => {
          const cut = file.path.lastIndexOf("/");
          const folder = cut > 0 ? file.path.slice(0, cut) : undefined;
          const comments = commentCounts?.[file.path];
          const row = (
            <button
              type="button"
              data-diff-tree-file={file.path}
              aria-current={activePath === file.path}
              onClick={() => onSelectFile(file.path)}
              // Two lines when narrow: the glyph, counts and badge sit on the name's 18px line, the folder runs alone below.
              className={`col-span-full grid h-10 grid-cols-subgrid items-start py-[3px] text-left text-13 transition-colors hover:bg-hover @[440px]:h-7 @[440px]:items-center @[440px]:py-0 ${activePath === file.path ? "bg-hover" : ""}`}
            >
              <span className="col-start-2 flex h-[18px] w-4 items-center justify-center text-ink-3">
                <HugeiconsIcon icon={File01Icon} size={14} strokeWidth={1.6} color="currentColor" />
              </span>
              <span className="flex min-w-0 flex-col @[440px]:col-span-2 @[440px]:grid @[440px]:grid-cols-subgrid @[440px]:items-center">
                <span className="min-w-0 truncate leading-[18px] text-ink">{file.path.slice(cut + 1)}</span>
                {folder ? <FolderPath path={folder} /> : <span />}
              </span>
              {comments ? (
                <span
                  data-diff-tree-comments={comments}
                  aria-label={`${comments} comments`}
                  className="flex h-[18px] items-center gap-0.5 text-11 text-ink-3 tabular-nums"
                >
                  <HugeiconsIcon icon={Comment01Icon} size={12} strokeWidth={1.8} color="currentColor" />
                  {comments}
                </span>
              ) : (
                <span />
              )}
              <Counts columns className="h-[18px]" added={file.binary ? 0 : file.added} removed={file.binary ? 0 : file.removed} />
              <span className="flex h-[18px] items-center">
                <StatusBox status={file.status} />
              </span>
            </button>
          );
          return folder ? (
            <Tooltip key={file.path} label={file.path} side="bottom" align="start" asChild>
              {row}
            </Tooltip>
          ) : (
            <Fragment key={file.path}>{row}</Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** A folder at the width its grid cell leaves it, measured with the cell's own font whenever the cell resizes. */
function FolderPath({ path }: { path: string }) {
  const cell = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState(path);
  useLayoutEffect(() => {
    const element = cell.current;
    if (!element) return;
    const context = document.createElement("canvas").getContext("2d");
    const fit = () => {
      if (!context) return;
      // Chromium leaves the `font` shorthand empty for many computed styles; build it from the longhands.
      const style = getComputedStyle(element);
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const room = element.clientWidth;
      setText(fitFolder(path, (candidate) => context.measureText(candidate).width <= room) ?? shortestFolder(path));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [path]);
  return (
    <span ref={cell} data-diff-tree-folder-path={path} className="min-w-0 truncate text-12 leading-4 text-ink-3">
      {text}
    </span>
  );
}

export function Tree({ nodes, depth, ...rest }: { nodes: DiffTreeNode<DiffFileEntry>[]; depth: number } & TreeProps) {
  return (
    <>
      {nodes.map((node) => (
        // A lone top folder's totals are the section's own, shown once in its header.
        <TreeRow key={node.path} node={node} depth={depth} hideTotals={depth === 0 && nodes.length === 1} {...rest} />
      ))}
    </>
  );
}

function TreeRow({
  node,
  depth,
  hideTotals,
  onSelectFile,
  activePath,
  commentCounts,
}: { node: DiffTreeNode<DiffFileEntry>; depth: number; hideTotals: boolean } & TreeProps) {
  const [collapsed, setCollapsed] = useState(false);
  const indent = { paddingLeft: 8 + depth * 12 };
  if (node.type === "file")
    return <FileRow file={node.file} name={node.name} style={indent} onSelectFile={onSelectFile} activePath={activePath} commentCounts={commentCounts} />;
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
        {!hideTotals && <Counts columns added={node.added} removed={node.removed} />}
        <span aria-hidden className={STATUS_CELL} />
      </button>
      {!collapsed && <Tree nodes={node.children} depth={depth + 1} onSelectFile={onSelectFile} activePath={activePath} commentCounts={commentCounts} />}
    </>
  );
}

function FileRow({ file, name, style, onSelectFile, activePath, commentCounts }: { file: DiffFileEntry; name: string; style: CSSProperties } & TreeProps) {
  const comments = commentCounts?.[file.path];
  return (
    <button
      type="button"
      data-diff-tree-file={file.path}
      aria-current={activePath === file.path}
      onClick={() => onSelectFile(file.path)}
      style={style}
      className={`flex h-7 w-full items-center gap-1.5 pr-3 text-left text-13 transition-colors hover:bg-hover ${activePath === file.path ? "bg-hover" : ""}`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">
        <HugeiconsIcon icon={File01Icon} size={14} strokeWidth={1.6} color="currentColor" />
      </span>
      <span className="min-w-0 flex-1 truncate text-ink">{name}</span>
      {comments ? (
        <span
          data-diff-tree-comments={comments}
          aria-label={`${comments} comments`}
          className="flex shrink-0 items-center gap-0.5 text-11 text-ink-3 tabular-nums"
        >
          <HugeiconsIcon icon={Comment01Icon} size={12} strokeWidth={1.8} color="currentColor" />
          {comments}
        </span>
      ) : null}
      <Counts columns added={file.binary ? 0 : file.added} removed={file.binary ? 0 : file.removed} />
      <StatusBox status={file.status} />
    </button>
  );
}

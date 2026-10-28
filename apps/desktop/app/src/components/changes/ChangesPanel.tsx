import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Comment01Icon,
  File01Icon,
  FileDiffIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import type { PullRequest } from "@milagre/shared/model";
import { pullRequestPresentation } from "@milagre/shared/pr-blockers";
import type { DiffFileEntry, DiffMode } from "../../electron";
import type { ChangesMode } from "../../lib/pull-request-view";
import { buildDiffTree, type DiffTreeNode } from "../../lib/diff-tree";
import { Select } from "../primitives/Select";
import type { Comparison } from "./useComparison";
import Tooltip from "../primitives/Tooltip";
import type { DiffList } from "./useDiffFiles";
import { ScrollArea } from "../primitives/ScrollArea";

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

/** The Changes tab's lists: what isn't committed yet, and what the branch committed since its base. */
export type ChangesLists = Record<DiffMode, DiffList>;

const filesOf = (list: DiffList) => (list.state === "ready" && list.isRepo ? list.files : []);

/** Files across both sections, the Changes tab's count; a file in both counts once. */
export const changedFileCount = (lists: ChangesLists) => new Set([...filesOf(lists.uncommitted), ...filesOf(lists.committed)].map((file) => file.path)).size;

/** The section a file opened from elsewhere (a transcript's link) shows in: the uncommitted one first. */
export const sectionOf = (lists: ChangesLists, path: string): DiffMode =>
  !filesOf(lists.uncommitted).some((file) => file.path === path) && filesOf(lists.committed).some((file) => file.path === path) ? "committed" : "uncommitted";

/** Diff comments per section, then per file path. */
export type CommentCounts = Partial<Record<ChangesMode, Record<string, number>>>;

/** The section the Changes tab opens the diff on: the uncommitted files, unless there are only committed ones. */
export const firstSection = (lists: ChangesLists): DiffMode =>
  filesOf(lists.uncommitted).length || !filesOf(lists.committed).length ? "uncommitted" : "committed";

export function ChangesPanel({
  lists,
  comparison,
  mode,
  onModeChange,
  onRefresh,
  onSelectFile,
  activePath,
  commentCounts,
  pullRequest,
}: {
  lists: ChangesLists;
  comparison?: Comparison;
  /** What the diff shows: one of the Changes tab's sections, or "pr" while a PR tab is selected. */
  mode: ChangesMode;
  onModeChange: (mode: ChangesMode) => void;
  onRefresh: () => void;
  /** A file picked in the Changes tab, with the section it was picked in. */
  onSelectFile: (path: string, mode: DiffMode) => void;
  activePath?: string;
  commentCounts?: CommentCounts;
  /** The Chat's PR the panel shows in "pr" mode, every PR it opened (a tab each), and what the panel shows in that mode. */
  pullRequest?: {
    number: number;
    choices?: PullRequest[];
    onPick?: (number: number) => void;
    loading: boolean;
    body: ReactNode;
  };
}) {
  const prShown = mode === "pr" && pullRequest;
  const prs = pullRequest?.choices ?? [];
  const tabs: PrTab[] = prs.map((pr) => ({ key: `pr:${pr.number}`, number: pr.number, pr }));
  // The shown PR keeps its tab even when the Chat's list hasn't caught up with it.
  if (pullRequest && !prs.some((pr) => pr.number === pullRequest.number)) tabs.push({ key: `pr:${pullRequest.number}`, number: pullRequest.number });
  return (
    <aside
      data-changes-panel
      data-changes-mode={prShown ? "pr" : undefined}
      aria-label={prShown ? "Pull request" : "Changes"}
      className="flex min-h-0 w-[var(--changes-panel-width,320px)] shrink-0 flex-col overflow-hidden rounded-window bg-surface shadow-card"
    >
      <ChangesTabs
        count={changedFileCount(lists)}
        prs={tabs}
        selected={prShown ? `pr:${pullRequest.number}` : undefined}
        onSelect={(key) => {
          if (key) pullRequest?.onPick?.(Number(key.slice(3)));
          onModeChange(key ? "pr" : firstSection(lists));
        }}
        onRefresh={onRefresh}
        loading={prShown ? pullRequest.loading : lists.uncommitted.state === "loading" || lists.committed.state === "loading"}
      />
      {prShown ? (
        pullRequest.body
      ) : (
        <>
          {comparison && <ComparisonControls comparison={comparison} />}
          <ScrollArea className="flex-1 py-1.5">
            {comparison?.view === "commits" ? (
              <CommitHistory comparison={comparison} />
            ) : (
              <ChangesSections lists={lists} mode={mode} onSelectFile={onSelectFile} activePath={activePath} commentCounts={commentCounts} />
            )}
          </ScrollArea>
        </>
      )}
    </aside>
  );
}

export function ComparisonControls({ comparison: c }: { comparison: Comparison }) {
  const data = c.data?.isRepo ? c.data : undefined;
  const options = [
    { value: "", label: "Automatic", description: "Recorded base or project default" },
    ...(data?.branches ?? []).map((branch) => ({ value: branch.ref, label: branch.name })),
  ];
  if (c.selected && !options.some((option) => option.value === c.selected))
    options.push({ value: c.selected, label: c.selected.replace(/^refs\/(heads|remotes)\//, "") });
  return (
    <div className="space-y-2 border-b border-line px-3 py-2">
      <p className="truncate text-[12px] font-medium text-ink" title={data?.branch ?? "Detached HEAD"}>
        Branch: {data?.branch ?? (c.data ? "Detached HEAD" : "…")}
      </p>
      <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
        <span className="shrink-0">Compare with</span>
        <Select label="Comparison branch" value={c.selected} options={options} onChange={c.select} searchable compact triggerClassName="min-w-0 flex-1" />
      </div>
      {data?.base && (
        <p className="break-words text-[11px] text-ink-3">
          Changes in {data.branch ?? "HEAD"} since {(data.comparisonRef ?? data.base).replace(/^refs\/(heads|remotes)\//, "")}
        </p>
      )}
      <div className="flex gap-1" aria-label="Changes view">
        {(["files", "commits"] as const).map((view) => (
          <button
            key={view}
            type="button"
            aria-pressed={c.view === view}
            onClick={() => c.setView(view)}
            className={`flex-1 rounded-control px-2 py-1 text-[12px] ${c.view === view ? "bg-hover text-ink" : "text-ink-3 hover:bg-hover"}`}
          >
            {view === "files" ? "Files" : "Commits"}
          </button>
        ))}
      </div>
      {c.error && (
        <button type="button" onClick={() => void c.refresh()} className="text-left text-[11px] text-red">
          {c.error}. Retry
        </button>
      )}
    </div>
  );
}

export function CommitHistory({ comparison: c }: { comparison: Comparison }) {
  if (!c.data) return <Notice>{c.error ?? "Reading commits…"}</Notice>;
  if (!c.data.isRepo) return <Notice>{c.data.message}</Notice>;
  return (
    <div className="space-y-2 p-2" data-commit-history>
      {!c.data.commits.length && <Notice>{c.data.message ?? "No commits since the comparison branch."}</Notice>}
      {c.data.commits.map((commit) => (
        <details key={commit.sha} className="rounded-control border border-line px-2.5 py-2 text-[12px]">
          <summary className="cursor-pointer break-words font-medium text-ink">
            {commit.message.split("\n")[0]}
            <span className="mt-1 block text-[11px] font-normal text-ink-3">
              {commit.author} · {new Date(commit.date).toLocaleString()}
            </span>
            <span className="mt-1 flex items-center justify-between gap-2 font-normal text-ink-2">
              <span>{commit.files} files</span>
              <Counts added={commit.added} removed={commit.removed} />
            </span>
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words text-ink-2">{commit.message}</p>
          <p className="mt-1 break-words text-ink-3">
            {commit.author} &lt;{commit.email}&gt;
          </p>
          <p className="mt-1 break-all font-mono text-[11px] text-ink-3">{commit.sha}</p>
        </details>
      ))}
      {c.data.hasMore && c.limit < 300 && (
        <button type="button" onClick={c.more} className="w-full rounded-control p-2 text-[12px] text-ink-2 hover:bg-hover">
          Show more commits
        </button>
      )}
      {c.data.hasMore && c.limit >= 300 && <Notice>Showing the latest 300 commits. Choose a closer comparison branch to narrow the history.</Notice>}
    </div>
  );
}

/** A PR's tab: `key` names it to the caller; `pr` colours its icon by state; `hint` says whose PR it is (a Link's Project). */
export type PrTab = { key: string; number: number; pr?: PullRequest; hint?: string };

const TONES = { purple: "text-purple-500", red: "text-red", orange: "text-orange", green: "text-green" } as const;

/** Merged purple, closed grey, otherwise the sidebar's tone: blocked red, checks running orange, open green. */
function prLook(pr: PullRequest | undefined) {
  if (!pr) return { icon: GitPullRequestIcon, tone: "text-ink-3", state: "" };
  if (pr.state === "MERGED") return { icon: GitMergeIcon, tone: TONES.purple, state: "Merged" };
  // ponytail: PullRequest has no CLOSED state today; a closed PR shows grey once it does.
  if (pr.state !== "OPEN") return { icon: GitPullRequestClosedIcon, tone: "text-ink-3", state: "Closed" };
  const look = pullRequestPresentation(pr);
  return { icon: GitPullRequestIcon, tone: TONES[look.tone], state: look.label || "Open" };
}

/** Left and right arrows select the next tab, as a tab row does. */
export function moveTab(event: KeyboardEvent<HTMLDivElement>) {
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!step) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")];
  const next = tabs[tabs.indexOf(document.activeElement as HTMLButtonElement) + step];
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.click();
}

const fade = (on: boolean) => (on ? "transparent, black 20px" : "black, black");

/**
 * The panel's tab row, shared with a Link's panel: "Changes N", one tab per PR, and the refresh button. `selected` is
 * the shown PR tab's key, undefined for Changes. The row scrolls sideways when the PRs don't fit.
 */
export function ChangesTabs({
  count,
  prs,
  selected,
  onSelect,
  onRefresh,
  loading,
}: {
  count: number;
  prs: PrTab[];
  selected?: string;
  onSelect: (key?: string) => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  const refreshLabel = selected ? "Refresh the PR" : "Refresh changes";
  const row = useRef<HTMLDivElement>(null);
  // Which edges have tabs scrolled out of sight, so a fade there says there are more.
  const [clipped, setClipped] = useState({ start: false, end: false });
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () => {
      const start = element.scrollLeft > 1,
        end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setClipped((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    element.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
    // A PR tab coming or going changes what is clipped.
  }, [prs.length]);
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line p-2">
      <div
        ref={row}
        role="tablist"
        aria-label="Changes and pull requests"
        data-changes-tabs
        data-clipped={[clipped.start && "start", clipped.end && "end"].filter(Boolean).join(" ") || undefined}
        onKeyDown={moveTab}
        style={
          clipped.start || clipped.end
            ? { maskImage: `linear-gradient(to right, ${fade(clipped.start)}, black calc(100% - 20px), ${clipped.end ? "transparent" : "black"})` }
            : undefined
        }
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
      >
        <PanelTab
          selected={!selected}
          onClick={() => {
            if (selected) onSelect();
          }}
          data-changes-tab="changes"
        >
          <HugeiconsIcon icon={FileDiffIcon} size={13} strokeWidth={1.8} color="currentColor" className="shrink-0" />
          Changes
          {count > 0 && <span className="text-[11.5px] font-normal text-ink-3 tabular-nums">{count}</span>}
        </PanelTab>
        {prs.map((tab) => {
          const look = prLook(tab.pr);
          const title = [tab.hint, tab.pr?.title, look.state].filter(Boolean).join(" · ");
          return (
            <PanelTab
              key={tab.key}
              selected={selected === tab.key}
              onClick={() => {
                if (selected !== tab.key) onSelect(tab.key);
              }}
              title={title || undefined}
              data-changes-tab={tab.key}
            >
              <HugeiconsIcon icon={look.icon} size={13} strokeWidth={1.8} color="currentColor" className={`shrink-0 ${look.tone}`} />#{tab.number}
            </PanelTab>
          );
        })}
      </div>
      <Tooltip label={refreshLabel} side="bottom" align="end">
        <button
          type="button"
          aria-label={refreshLabel}
          data-diff-refresh
          onClick={onRefresh}
          className="flex size-7 shrink-0 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          <span className={loading ? "animate-spin" : ""}>
            <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.8} color="currentColor" />
          </span>
        </button>
      </Tooltip>
    </div>
  );
}

function PanelTab({
  selected,
  children,
  ...props
}: {
  selected: boolean;
  children: ReactNode;
  onClick: () => void;
  title?: string;
  "data-changes-tab": string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-[12.5px] whitespace-nowrap transition-colors ${selected ? "bg-hover font-semibold text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
      {...props}
    >
      {children}
    </button>
  );
}

const SECTIONS = [
  { mode: "uncommitted", label: "Not committed" },
  { mode: "committed", label: "On this branch" },
] as const;

/**
 * The Changes tab's list: a section for each mode that has files, each its own tree. The open file is marked only in
 * the section the diff shows (`mode`), since a file can be in both.
 */
export function ChangesSections({
  lists,
  mode,
  onSelectFile,
  activePath,
  commentCounts,
}: {
  lists: ChangesLists;
  mode: ChangesMode;
  onSelectFile: (path: string, mode: DiffMode) => void;
  activePath?: string;
  commentCounts?: CommentCounts;
}) {
  const sections = SECTIONS.filter((section) => filesOf(lists[section.mode]).length > 0);
  const all = [lists.uncommitted, lists.committed];
  // Outside a repository both lists say so; a failed read shows under whatever the other list has.
  const problem = all.find((list): list is Extract<DiffList, { message: string }> => list.state === "error" || (list.state === "ready" && !list.isRepo));
  const message = all.map((list) => (list.state === "ready" && list.isRepo ? list.message : undefined)).find(Boolean);
  return (
    <>
      {sections.map((section) => (
        <ChangesSection
          key={section.mode}
          label={section.label}
          list={lists[section.mode]}
          onSelectFile={(path) => onSelectFile(path, section.mode)}
          activePath={mode === section.mode ? activePath : undefined}
          commentCounts={commentCounts?.[section.mode]}
        />
      ))}
      {problem && <Notice>{problem.message}</Notice>}
      {!sections.length && !problem && <Notice>{all.some((list) => list.state !== "ready") ? "Loading changes…" : (message ?? "No changes yet.")}</Notice>}
    </>
  );
}

function ChangesSection({ label, list, ...treeProps }: { label: string; list: DiffList } & TreeProps) {
  const files = filesOf(list);
  const tree = useMemo(() => buildDiffTree(files), [files]);
  const base = list.state === "ready" && list.isRepo ? list.base : null;
  return (
    <section aria-label={label} data-changes-section={label} className="pb-1.5">
      <h3 className="flex h-7 items-center gap-1.5 px-3 text-[11.5px] text-ink-3">
        <span className="font-medium text-ink-2">{label}</span>
        <span className="tabular-nums">{files.length}</span>
        {base && (
          <span data-diff-base className="min-w-0 truncate">
            since <span className="font-mono">{base}</span>
          </span>
        )}
        <span className="flex-1" />
        <Counts added={files.reduce((sum, file) => sum + file.added, 0)} removed={files.reduce((sum, file) => sum + file.removed, 0)} />
      </h3>
      <Tree nodes={tree} depth={0} {...treeProps} />
    </section>
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

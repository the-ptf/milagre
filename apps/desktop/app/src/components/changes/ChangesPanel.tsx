import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Comment01Icon,
  ArrowLeft01Icon,
  CloudIcon,
  GitBranchIcon,
  GitCommitIcon,
  Copy01Icon,
  Cancel01Icon,
  File01Icon,
  FileDiffIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { branchName, commitInitials, comparisonOptions, commitStatsNotice } from "@milagre/shared/git-diff";
import type { GitCommit } from "@milagre/shared/git-diff";
import type { PullRequest } from "@milagre/shared/model";
import { PR_TONE, pullRequestPresentation } from "@milagre/shared/pr-blockers";
import { UI_COPY } from "@milagre/shared/model-copy";
import type { DiffFileEntry, DiffMode } from "../../electron";
import type { ChangesMode } from "../../lib/pull-request-view";
import { buildDiffTree, type DiffTreeNode } from "../../lib/diff-tree";
import { Select } from "../primitives/Select";
import type { Comparison } from "./useComparison";
import Tooltip from "../primitives/Tooltip";
import type { DiffList } from "./useDiffFiles";
import { useRefreshSpin } from "./useRefreshSpin";
import { ScrollArea } from "../primitives/ScrollArea";
import { Icon } from "../primitives/Icon";
import { Button, IconButton } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { InlineError } from "../primitives/InlineError";
import { Tabs } from "../primitives/Tabs";

const STATUS = {
  added: { letter: "A", label: "Added", className: "bg-green-tint text-diff-add" },
  deleted: { letter: "D", label: "Deleted", className: "bg-red-tint text-diff-remove" },
  modified: { letter: "M", label: "Modified", className: "bg-orange-tint text-orange-ink" },
  renamed: { letter: "R", label: "Renamed", className: "bg-accent-tint text-accent-ink" },
} as const;

export function Counts({ added, removed, className = "", total = false }: { added: number; removed: number; className?: string; total?: boolean }) {
  return (
    <span data-diff-counts={total ? "total" : ""} className={`flex shrink-0 items-center gap-1.5 font-mono text-11 tabular-nums ${className}`}>
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
      className={`flex size-4 shrink-0 items-center justify-center rounded-inline font-mono text-10 font-semibold ${className}`}
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
  /** Its promise, when it returns one, keeps the refresh icon spinning until the read is done. */
  onRefresh: () => void | Promise<unknown>;
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
          {comparison && <ComparisonControls comparison={comparison} fileCount={changedFileCount(lists)} />}
          <ScrollArea className="flex-1 py-1.5">
            {comparison?.view === "commits" ? (
              <CommitHistory comparison={comparison} />
            ) : (
              <ChangesSections
                compactComparison={!!comparison && !comparison.unavailable}
                lists={lists}
                mode={mode}
                onSelectFile={onSelectFile}
                activePath={activePath}
                commentCounts={commentCounts}
              />
            )}
          </ScrollArea>
        </>
      )}
    </aside>
  );
}

/** Both ends stay visible when a branch exceeds the row's available width. */
function BranchLabel({ name }: { name: string }) {
  const split = Math.ceil(name.length * 0.55);
  return (
    <span title={name} className="flex min-w-0 flex-1 text-left">
      <span className="min-w-0 truncate">{name.slice(0, split)}</span>
      <span className="max-w-[45%] shrink-0 overflow-hidden whitespace-nowrap [direction:rtl]">{name.slice(split)}</span>
    </span>
  );
}

export function ComparisonControls({ comparison: c, fileCount }: { comparison: Comparison; fileCount?: number }) {
  if (c.unavailable) return null;
  const data = c.data?.isRepo ? c.data : undefined;
  const base = branchName(data?.comparisonRef || c.selected || data?.base || "Automatic");
  const current = data?.branch ?? data?.head?.slice(0, 8) ?? (c.data ? "HEAD" : "…");
  const icon = (remote: boolean) => <Icon icon={remote ? CloudIcon : GitBranchIcon} size={14} className="shrink-0 text-ink-3" />;
  const options = comparisonOptions(data).map((option) => ({
    ...option,
    wrapLabel: true,
    icon: icon(option.value === c.selected ? !!data?.comparisonRef?.startsWith("refs/remotes/") : option.remote),
    display: <BranchLabel name={base} />,
  }));
  const fallback = data?.projectDefault;
  return (
    <div className="@container border-b border-line" data-comparison-controls>
      <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-12 text-ink-3">
        <Select
          label="Comparison branch"
          value={c.selected}
          options={options}
          onChange={c.select}
          searchable
          compact
          variant="chip"
          triggerClassName="min-w-[64px] max-w-[50%] shrink"
        />
        <Icon icon={ArrowLeft01Icon} size={14} className="hidden shrink-0 @[300px]:block" />
        <span className="flex min-w-0 flex-1 items-center gap-1.5" aria-label={`Current branch: ${data?.branch ?? `detached HEAD ${current}`}`}>
          <Icon icon={data?.branch ? GitBranchIcon : GitCommitIcon} size={14} className="hidden shrink-0 @[300px]:block" />
          <BranchLabel name={current} />
          {data && !data.branch && <span className="shrink-0 rounded-inline bg-field px-1 text-10 text-ink-2">detached</span>}
        </span>
      </div>
      <Tabs
        label="Changes view"
        value={c.view}
        options={[
          { value: "files", label: "Files", count: fileCount },
          { value: "commits", label: "Commits", count: data?.total },
        ]}
        onChange={c.setView}
        dataKey="comparison-view"
        className="px-3 pb-2"
      />
      {c.missing && (
        <div role="status" className="flex items-start gap-2 px-3 py-2 text-11 text-ink-3">
          <p className="min-w-0 flex-1 break-words">
            {c.missing} no longer exists. {data?.base ? `Showing changes since ${data.base}.` : "Restoring the automatic base…"}
          </p>
          <IconButton label="Dismiss missing branch notice" icon={Cancel01Icon} size={20} onClick={c.dismissMissing} />
        </div>
      )}
      {data?.message && (
        <div className="px-3 py-2 text-11 text-ink-3">
          <p>{data.message}</p>
          {fallback?.ref && fallback.ref !== data.comparisonRef && (
            <Button variant="link" size={24} onClick={() => c.select(fallback.ref!)} className="mt-1 -ml-2">
              Compare with {fallback.name} instead
            </Button>
          )}
        </div>
      )}
      {c.error && (
        <div className="flex items-center gap-2 px-3 py-2">
          <InlineError size={12} className="min-w-0 flex-1">
            {c.error}.
          </InlineError>
          <Button variant="quiet" size={24} onClick={() => void c.refresh()}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

export function CommitHistory({ comparison: c }: { comparison: Comparison }) {
  if (!c.data) return <Notice>{c.error ?? "Reading commits…"}</Notice>;
  if (!c.data.isRepo) return <Notice>{c.data.message}</Notice>;
  return (
    <div className="divide-y divide-line px-3" data-commit-history>
      {!c.data.commits.length && !c.data.message && (
        <Notice>{c.loading ? "Reading commits…" : (c.data.message ?? "No commits since the comparison branch.")}</Notice>
      )}
      {c.data.commits.map((commit) => (
        <CommitRow key={commit.sha} commit={commit} />
      ))}
      {c.data.hasMore && c.limit < 300 && (
        <Button variant="quiet" size={28} onClick={c.more} disabled={c.loading} className="w-full">
          Show more commits
        </Button>
      )}
      {c.data.hasMore && c.limit >= 300 && <Notice>Showing the latest 300 commits. Choose a closer comparison branch to narrow the history.</Notice>}
    </div>
  );
}

function CommitRow({ commit }: { commit: GitCommit }) {
  const [copy, setCopy] = useState("Copy SHA");
  return (
    <details className="py-3 text-12">
      <summary className="cursor-pointer list-none font-medium text-ink">
        <span className="line-clamp-2 break-words">{commit.message.split("\n")[0]}</span>
        <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-11 font-normal text-ink-3">
          <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-full bg-hover-2 text-10 leading-none text-ink-2">
            {commitInitials(commit.author)}
          </span>
          <span className="min-w-0 truncate" title={`${commit.author} <${commit.email}>`}>
            {commit.author}
          </span>
          <Tooltip label={new Date(commit.date).toLocaleString()} className="shrink-0">
            <time dateTime={commit.date}>{new Date(commit.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>
          </Tooltip>
          {commit.statsUnavailable ? (
            <Tooltip label={commitStatsNotice(commit.statsUnavailable)} align="end" wrap className="ml-auto">
              <span>Totals unavailable</span>
            </Tooltip>
          ) : (
            <>
              <span className="ml-auto shrink-0">
                {commit.files} {commit.files === 1 ? "file" : "files"}
              </span>
              <Counts added={commit.added} removed={commit.removed} />
            </>
          )}
        </span>
      </summary>
      <div className="mt-2 border-l-2 border-line pl-3">
        {commit.statsUnavailable && <p className="mb-2 text-11 text-ink-3">{commitStatsNotice(commit.statsUnavailable)}</p>}
        <p className="whitespace-pre-wrap break-words text-ink-2">{commit.message}</p>
        <p className="mt-2 break-words text-11 text-ink-3">
          {commit.author} &lt;{commit.email}&gt; · {new Date(commit.date).toLocaleString()}
        </p>
        <Tooltip label={commit.sha} className="mt-2">
          <button
            type="button"
            aria-label={copy}
            onClick={() =>
              void navigator.clipboard.writeText(commit.sha).then(
                () => setCopy("SHA copied"),
                () => setCopy("Copy failed. Retry"),
              )
            }
            className="flex h-6 items-center gap-1.5 rounded-control bg-field px-2 font-mono text-11 text-ink-2 transition-colors hover:text-ink"
          >
            {commit.sha.slice(0, 8)}
            <Icon icon={Copy01Icon} size={12} />
            <span className="sr-only">{copy}</span>
          </button>
        </Tooltip>
      </div>
    </details>
  );
}

/** A PR's tab: `key` names it to the caller; `pr` colours its icon by state; `hint` says whose PR it is (a Link's Project). */
export type PrTab = { key: string; number: number; pr?: PullRequest; hint?: string };

// The icon in the fill colour (PR_TONE, as in the sidebar and on the phone); written out so Tailwind sees the classes.
const ICON_TONE = { green: "text-green", orange: "text-orange", red: "text-red", purple: "text-purple" } as const;

/** Merged purple, closed grey, otherwise the sidebar's tone: blocked red, checks running orange, open green. */
function prLook(pr: PullRequest | undefined) {
  if (!pr) return { icon: GitPullRequestIcon, tone: "text-ink-3", state: "" };
  if (pr.state === "MERGED") return { icon: GitMergeIcon, tone: ICON_TONE[PR_TONE.purple.icon], state: "Merged" };
  // ponytail: PullRequest has no CLOSED state today; a closed PR shows grey once it does.
  if (pr.state !== "OPEN") return { icon: GitPullRequestClosedIcon, tone: "text-ink-3", state: "Closed" };
  const look = pullRequestPresentation(pr);
  return { icon: GitPullRequestIcon, tone: ICON_TONE[PR_TONE[look.tone].icon], state: look.label || "Open" };
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
  onRefresh: () => void | Promise<unknown>;
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
          <Icon icon={FileDiffIcon} size={14} className="shrink-0" />
          Changes
          {count > 0 && <span className="text-ink-3 tabular-nums">{count}</span>}
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
              tooltip={title || undefined}
              data-changes-tab={tab.key}
            >
              <Icon icon={look.icon} size={14} className={`shrink-0 ${look.tone}`} />#{tab.number}
            </PanelTab>
          );
        })}
      </div>
      <RefreshButton label={refreshLabel} onRefresh={onRefresh} loading={loading} />
    </div>
  );
}

function PanelTab({
  selected,
  children,
  tooltip,
  ...props
}: {
  selected: boolean;
  children: ReactNode;
  onClick: () => void;
  tooltip?: string;
  "data-changes-tab": string;
}) {
  const tab = (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      // The Tabs look (primitives/Tabs), kept by hand for the PR tabs' coloured icons and tooltips.
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-12 font-medium whitespace-nowrap transition-colors active:bg-hover-2 ${selected ? "bg-hover-2 text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
      {...props}
    >
      {children}
    </button>
  );
  return tooltip ? (
    <Tooltip label={tooltip} side="bottom" wrap className="shrink-0">
      {tab}
    </Tooltip>
  ) : (
    tab
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
  compactComparison = false,
  lists,
  mode,
  onSelectFile,
  activePath,
  commentCounts,
}: {
  compactComparison?: boolean;
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
          compactComparison={compactComparison}
          list={lists[section.mode]}
          onSelectFile={(path) => onSelectFile(path, section.mode)}
          activePath={mode === section.mode ? activePath : undefined}
          commentCounts={commentCounts?.[section.mode]}
        />
      ))}
      {problem?.state === "error" ? (
        <InlineError size={12} className="px-4 py-6 text-center">
          {problem.message}
        </InlineError>
      ) : (
        problem && <Notice>{problem.message}</Notice>
      )}
      {!sections.length && !problem && <Notice>{all.some((list) => list.state !== "ready") ? "Loading changes…" : (message ?? UI_COPY.noChanges)}</Notice>}
    </>
  );
}

function ChangesSection({ label, list, compactComparison, ...treeProps }: { label: string; list: DiffList; compactComparison: boolean } & TreeProps) {
  const files = filesOf(list);
  const tree = useMemo(() => buildDiffTree(files), [files]);
  const base = list.state === "ready" && list.isRepo ? list.base : null;
  return (
    <section aria-label={label} data-changes-section={label} className="pb-1.5">
      <h3 className="flex h-7 items-center gap-1.5 px-3 text-11 text-ink-3">
        <span className="font-medium text-ink-2">{label}</span>
        <span className="tabular-nums">{files.length}</span>
        {label === "Not committed" && <span>vs HEAD</span>}
        {base && !compactComparison && (
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
  return <EmptyState size="compact" title={children} />;
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
        className={`flex h-7 w-full items-center gap-1.5 pr-3 text-left text-13 transition-colors ${activePath === node.path ? "bg-hover-2" : "hover:bg-hover"}`}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">
          <Icon icon={File01Icon} size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate text-ink">{node.name}</span>
        {commentCounts?.[node.path] ? (
          <span
            data-diff-tree-comments={commentCounts[node.path]}
            aria-label={`${commentCounts[node.path]} comments`}
            className="flex shrink-0 items-center gap-0.5 text-11 text-ink-3 tabular-nums"
          >
            <Icon icon={Comment01Icon} size={12} />
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
          <Icon icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon} size={12} />
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

/** Spins from the click until the read is done; see useRefreshSpin. */
function RefreshButton({ label, onRefresh, loading }: { label: string; onRefresh: () => void | Promise<unknown>; loading: boolean }) {
  const spin = useRefreshSpin(onRefresh, loading);
  return (
    <Tooltip label={label} side="bottom" align="end" asChild>
      <IconButton label={label} size={28} aria-busy={spin.busy || undefined} data-diff-refresh onClick={spin.refresh}>
        <span
          className={spin.spinning ? "refresh-spin animate-spin" : ""}
          onAnimationIteration={spin.onAnimationIteration}
          onAnimationEnd={spin.onAnimationEnd}
        >
          <Icon icon={RefreshIcon} size={14} />
        </span>
      </IconButton>
    </Tooltip>
  );
}

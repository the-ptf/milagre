import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft02Icon,
  CloudIcon,
  GitBranchIcon,
  GitCommitIcon,
  Copy01Icon,
  Cancel01Icon,
  FileDiffIcon,
  GitPullRequestIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { branchName, commitInitials, comparisonOptions, commitStatsNotice } from "@milagre/shared/git-diff";
import type { GitCommit } from "@milagre/shared/git-diff";
import type { PullRequest } from "@milagre/shared/model";
import { prLook } from "../../lib/pr-look";
import type { DiffMode } from "../../electron";
import type { ChangesMode } from "../../lib/pull-request-view";
import { buildDiffTree } from "../../lib/diff-tree";
import { Segmented } from "../primitives/Segmented";
import { Select } from "../primitives/Select";
import type { Comparison } from "./useComparison";
import Tooltip from "../primitives/Tooltip";
import type { DiffList } from "./useDiffFiles";
import { useRefreshSpin } from "./useRefreshSpin";
import { FLAT_LIST_MAX, FlatList, Tree, type TreeProps } from "./DiffTree";
import { Counts } from "./DiffIndicators";
export { Counts } from "./DiffIndicators";
import { CommitFiles } from "./CommitFiles";
import { ScrollArea } from "../primitives/ScrollArea";

export type ChangesLists = Record<DiffMode, DiffList>;

const filesOf = (list: DiffList) => (list.state === "ready" && list.isRepo ? list.files : []);

export const changedFileCount = (lists: ChangesLists) => new Set([...filesOf(lists.uncommitted), ...filesOf(lists.committed)].map((file) => file.path)).size;

export const sectionOf = (lists: ChangesLists, path: string): DiffMode =>
  !filesOf(lists.uncommitted).some((file) => file.path === path) && filesOf(lists.committed).some((file) => file.path === path) ? "committed" : "uncommitted";

export type CommentCounts = Partial<Record<ChangesMode, Record<string, number>>>;

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
  mode: ChangesMode;
  onModeChange: (mode: ChangesMode) => void;
  onRefresh: () => void | Promise<unknown>;
  onSelectFile: (path: string, mode: DiffMode) => void;
  activePath?: string;
  commentCounts?: CommentCounts;
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
  if (pullRequest && !prs.some((pr) => pr.number === pullRequest.number)) tabs.push({ key: `pr:${pullRequest.number}`, number: pullRequest.number });
  return (
    <aside
      data-changes-panel
      data-changes-mode={prShown ? "pr" : undefined}
      aria-label={prShown ? "Pull request" : "Changes"}
      className="panel-grain flex min-h-0 w-[var(--changes-panel-width,320px)] shrink-0 flex-col overflow-hidden rounded-window bg-surface shadow-card"
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
              <ChangesSections lists={lists} mode={mode} onSelectFile={onSelectFile} activePath={activePath} commentCounts={commentCounts} />
            )}
          </ScrollArea>
        </>
      )}
    </aside>
  );
}

function BranchLabel({ name }: { name: string }) {
  const split = Math.ceil(name.length * 0.55);
  return (
    <span title={name} className="flex min-w-0 flex-1 text-left font-mono text-11">
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
  const icon = (remote: boolean) => <HugeiconsIcon icon={remote ? CloudIcon : GitBranchIcon} size={14} className="shrink-0 text-ink-3" />;
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
        <HugeiconsIcon icon={ArrowLeft02Icon} size={14} aria-hidden className="hidden shrink-0 @[300px]:block" />
        <span className="flex min-w-0 flex-1 items-center gap-1.5" aria-label={`Current branch: ${data?.branch ?? `detached HEAD ${current}`}`}>
          <HugeiconsIcon icon={data?.branch ? GitBranchIcon : GitCommitIcon} size={14} className="hidden shrink-0 @[300px]:block" />
          <BranchLabel name={current} />
          {data && !data.branch && <span className="shrink-0 rounded-inline bg-field px-1 text-10 text-ink-2">detached</span>}
        </span>
      </div>
      <Segmented
        label="Changes view"
        value={c.view}
        onChange={c.setView}
        dataKey="comparison-view"
        className="mx-3 mb-2"
        options={[
          { value: "files", label: "Files", count: fileCount },
          { value: "commits", label: "Commits", count: data?.total },
        ]}
      />
      {c.missing && (
        <div role="status" className="flex items-start gap-2 px-3 py-2 text-11 text-ink-3">
          <p className="min-w-0 flex-1 break-words">
            {c.missing} no longer exists. {data?.base ? `Showing changes since ${data.base}.` : "Restoring the automatic base…"}
          </p>
          <button type="button" aria-label="Dismiss missing branch notice" onClick={c.dismissMissing}>
            <HugeiconsIcon icon={Cancel01Icon} size={13} />
          </button>
        </div>
      )}
      {data?.message && (
        <div className="px-3 py-2 text-11 text-ink-3">
          <p>{data.message}</p>
          {fallback?.ref && fallback.ref !== data.comparisonRef && (
            <button type="button" onClick={() => c.select(fallback.ref!)} className="mt-1 text-accent-ink hover:underline">
              Compare with {fallback.name} instead
            </button>
          )}
        </div>
      )}
      {c.error && (
        <button type="button" onClick={() => void c.refresh()} className="px-3 py-2 text-11 text-ink-3">
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
    <div className="divide-y divide-line px-3" data-commit-history>
      {!c.data.commits.length && !c.data.message && (
        <Notice>{c.loading ? "Reading commits…" : (c.data.message ?? "No commits since the comparison branch.")}</Notice>
      )}
      {c.data.commits.map((commit) => (
        <CommitRow key={`${c.cwd}:${commit.sha}`} commit={commit} comparison={c} />
      ))}
      {c.data.hasMore && c.limit < 300 && (
        <button type="button" onClick={c.more} disabled={c.loading} className="w-full rounded-control p-2 text-12 text-ink-2 hover:bg-hover">
          Show more commits
        </button>
      )}
      {c.data.hasMore && c.limit >= 300 && <Notice>Showing the latest 300 commits. Choose a closer comparison branch to narrow the history.</Notice>}
    </div>
  );
}

function CommitRow({ commit, comparison }: { commit: GitCommit; comparison: Comparison }) {
  const [showFiles, setShowFiles] = useState(false);
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
          <time className="shrink-0" dateTime={commit.date} title={new Date(commit.date).toLocaleString()}>
            {new Date(commit.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </time>
          {commit.statsUnavailable ? (
            <span className="ml-auto" title={commitStatsNotice(commit.statsUnavailable)}>
              Totals unavailable
            </span>
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
        <button
          type="button"
          title={commit.sha}
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
          <HugeiconsIcon icon={Copy01Icon} size={12} />
          <span className="sr-only">{copy}</span>
        </button>
        <button
          type="button"
          aria-expanded={showFiles}
          onClick={() => setShowFiles((value) => !value)}
          className="mt-2 min-h-6 rounded-control px-2 text-12 text-ink-2 transition-colors hover:bg-hover active:bg-hover-2"
        >
          {showFiles ? "Hide files in this commit" : "Show files in this commit"}
        </button>
        {showFiles && <CommitFiles cwd={comparison.cwd} sha={commit.sha} bridge={comparison.bridge} />}
      </div>
    </details>
  );
}

export type PrTab = { key: string; number: number; pr?: PullRequest; hint?: string };

function tabLook(pr: PullRequest | undefined) {
  if (!pr) return { glyph: GitPullRequestIcon, toneClass: "text-ink-3", state: "" };
  const look = prLook(pr);
  return { glyph: look.glyph, toneClass: look.toneClass, state: look.label || "Open" };
}

function moveTab(event: KeyboardEvent<HTMLDivElement>) {
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
  }, [prs.length]);
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-2">
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
          {count > 0 && <span className="text-11 font-normal text-ink-3 tabular-nums">{count}</span>}
        </PanelTab>
        {prs.map((tab) => {
          const look = tabLook(tab.pr);
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
              <HugeiconsIcon icon={look.glyph} size={13} strokeWidth={1.8} color="currentColor" className={`shrink-0 ${look.toneClass}`} />#{tab.number}
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
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-12 whitespace-nowrap transition-colors ${selected ? "bg-hover font-semibold text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
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
      <h3 className="flex h-7 items-center px-3 text-12 text-ink-3">
        <Tooltip label={label === "Not committed" ? "Compared with the last commit" : `Compared with ${base ?? "the base branch"}`} side="bottom" align="start">
          <span>{label}</span>
        </Tooltip>
      </h3>
      {files.length <= FLAT_LIST_MAX ? <FlatList files={files} {...treeProps} /> : <Tree nodes={tree} depth={0} {...treeProps} />}
    </section>
  );
}

function Notice({ children }: { children: string }) {
  return <p className="px-3 py-2 text-11 text-ink-3">{children}</p>;
}

function RefreshButton({ label, onRefresh, loading }: { label: string; onRefresh: () => void | Promise<unknown>; loading: boolean }) {
  const spin = useRefreshSpin(onRefresh, loading);
  return (
    <Tooltip label={label} side="bottom" align="end">
      <button
        type="button"
        aria-label={label}
        aria-busy={spin.busy || undefined}
        data-diff-refresh
        onClick={spin.refresh}
        className="flex size-7 shrink-0 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-hover hover:text-ink"
      >
        <span className={spin.spinning ? "animate-spin" : ""} onAnimationIteration={spin.onAnimationIteration}>
          <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.8} color="currentColor" />
        </span>
      </button>
    </Tooltip>
  );
}

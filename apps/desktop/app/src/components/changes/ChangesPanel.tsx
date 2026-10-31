import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
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
import { Select } from "../primitives/Select";
import type { Comparison } from "./useComparison";
import Tooltip from "../primitives/Tooltip";
import type { DiffList } from "./useDiffFiles";
import { useRefreshSpin } from "./useRefreshSpin";
import { Tree, type TreeProps } from "./DiffTree";
import { Counts } from "./DiffIndicators";
export { Counts } from "./DiffIndicators";
import { CommitFiles } from "./CommitFiles";
import { ScrollArea } from "../primitives/ScrollArea";

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
      <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-[12px] text-ink-3">
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
        <HugeiconsIcon icon={ArrowLeft01Icon} size={14} className="hidden shrink-0 @[300px]:block" />
        <span className="flex min-w-0 flex-1 items-center gap-1.5" aria-label={`Current branch: ${data?.branch ?? `detached HEAD ${current}`}`}>
          <HugeiconsIcon icon={data?.branch ? GitBranchIcon : GitCommitIcon} size={14} className="hidden shrink-0 @[300px]:block" />
          <BranchLabel name={current} />
          {data && !data.branch && <span className="shrink-0 rounded bg-hover px-1 text-[10px]">detached</span>}
        </span>
      </div>
      <div className="flex gap-5 px-3" aria-label="Changes view" role="tablist" onKeyDown={moveTab}>
        {(["files", "commits"] as const).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={c.view === view}
            tabIndex={c.view === view ? 0 : -1}
            data-comparison-view={view}
            onClick={() => c.setView(view)}
            className={`flex items-center gap-1.5 border-b-2 py-2 text-[12px] ${c.view === view ? "border-accent font-semibold text-ink" : "border-transparent text-ink-3 hover:text-ink"}`}
          >
            {view === "files" ? "Files" : "Commits"}
            <span className="font-normal tabular-nums text-ink-3">{view === "files" ? fileCount : data?.total}</span>
          </button>
        ))}
      </div>
      {c.missing && (
        <div role="status" className="flex items-start gap-2 px-3 py-2 text-[11px] text-ink-3">
          <p className="min-w-0 flex-1 break-words">
            {c.missing} no longer exists. {data?.base ? `Showing changes since ${data.base}.` : "Restoring the automatic base…"}
          </p>
          <button type="button" aria-label="Dismiss missing branch notice" onClick={c.dismissMissing}>
            <HugeiconsIcon icon={Cancel01Icon} size={13} />
          </button>
        </div>
      )}
      {data?.message && (
        <div className="px-3 py-2 text-[11px] text-ink-3">
          <p>{data.message}</p>
          {fallback?.ref && fallback.ref !== data.comparisonRef && (
            <button type="button" onClick={() => c.select(fallback.ref!)} className="mt-1 text-accent-ink hover:underline">
              Compare with {fallback.name} instead
            </button>
          )}
        </div>
      )}
      {c.error && (
        <button type="button" onClick={() => void c.refresh()} className="px-3 py-2 text-left text-[11px] text-red-ink">
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
        <button type="button" onClick={c.more} disabled={c.loading} className="w-full rounded-control p-2 text-[12px] text-ink-2 hover:bg-hover">
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
    <details className="py-2.5 text-[12px]">
      <summary className="cursor-pointer list-none font-medium text-ink">
        <span className="line-clamp-2 break-words">{commit.message.split("\n")[0]}</span>
        <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] font-normal text-ink-3">
          <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-full bg-hover text-[8px] text-ink-2">
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
      <div className="mt-2 border-l-2 border-line pl-2.5">
        {commit.statsUnavailable && <p className="mb-2 text-[11px] text-ink-3">{commitStatsNotice(commit.statsUnavailable)}</p>}
        <p className="whitespace-pre-wrap break-words text-ink-2">{commit.message}</p>
        <p className="mt-2 break-words text-[11px] text-ink-3">
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
          className="mt-2 flex items-center gap-1.5 rounded-control bg-hover px-2 py-1 font-mono text-[11px] text-ink-2"
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

/** A PR's tab: `key` names it to the caller; `pr` colours its icon by state; `hint` says whose PR it is (a Link's Project). */
export type PrTab = { key: string; number: number; pr?: PullRequest; hint?: string };

/** A PR tab's glyph, colour and state words; grey until its status is read. */
function tabLook(pr: PullRequest | undefined) {
  if (!pr) return { glyph: GitPullRequestIcon, toneClass: "text-ink-3", state: "" };
  const look = prLook(pr);
  return { glyph: look.glyph, toneClass: look.toneClass, state: look.label || "Open" };
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
          <HugeiconsIcon icon={FileDiffIcon} size={13} strokeWidth={1.8} color="currentColor" className="shrink-0" />
          Changes
          {count > 0 && <span className="text-[11.5px] font-normal text-ink-3 tabular-nums">{count}</span>}
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
      {problem && <Notice>{problem.message}</Notice>}
      {!sections.length && !problem && <Notice>{all.some((list) => list.state !== "ready") ? "Loading changes…" : (message ?? "No changes yet.")}</Notice>}
    </>
  );
}

function ChangesSection({ label, list, compactComparison, ...treeProps }: { label: string; list: DiffList; compactComparison: boolean } & TreeProps) {
  const files = filesOf(list);
  const tree = useMemo(() => buildDiffTree(files), [files]);
  const base = list.state === "ready" && list.isRepo ? list.base : null;
  return (
    <section aria-label={label} data-changes-section={label} className="pb-1.5">
      <h3 className="flex h-7 items-center gap-1.5 px-3 text-[11.5px] text-ink-3">
        <span className="font-medium text-ink-2">{label}</span>
        <span className="tabular-nums">{files.length}</span>
        {label === "Not committed" && <span className="text-[10px]">vs HEAD</span>}
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
  return <p className="px-4 py-6 text-center text-[12px] text-ink-3">{children}</p>;
}

/** Spins from the click until the read is done; see useRefreshSpin. */
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

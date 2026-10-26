import { useEffect, useMemo, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  CloudUploadIcon,
  ArrowRight01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  Comment01Icon,
  EyeIcon,
  File01Icon,
  GitMergeIcon,
  LinkSquare02Icon,
  Loading03Icon,
  MinusSignCircleIcon,
  RefreshIcon,
  SparklesIcon,
  Tick02Icon,
  UserCheck01Icon,
} from "@hugeicons/core-free-icons";
import {
  canMergeNow,
  checksOutcome,
  checksSummary,
  mergeStatus,
  notInPrLabel,
  openThreads,
  type MergeMethod,
  type GuideStop,
  type PullRequestCheck,
  type PullRequestDetail,
  type PullRequestFile,
  type PullRequestThread,
} from "@milagre/shared/pull-request-review";
import { buildDiffTree, type DiffTreeNode } from "../../lib/diff-tree";
import { guideStale, MERGE_METHODS, nextStop, readMergeMethod, saveMergeMethod, viewedCount } from "../../lib/pull-request-view";
import { Markdown } from "../markdown/Markdown";
import { ScrollArea } from "../primitives/ScrollArea";
import { Select } from "../primitives/Select";
import Tooltip from "../primitives/Tooltip";
import { Counts } from "./ChangesPanel";
import { providerName } from "@milagre/shared/providers";
import type { ModelProvider } from "../../model";
import type { PullRequestReview, ReviewGuideState } from "./usePullRequest";

// The Changes panel's "PR #n" mode: the PR the Chat's branch opened, its merge box, checks, reviews, guide and files.
// Files open in the main column's diff; the guide opens there too, and then this panel lists its stops.

const CHECK_ICON: Record<PullRequestCheck["outcome"], { icon: IconSvgElement; className: string }> = {
  pass: { icon: CheckmarkCircle02Icon, className: "text-green" },
  fail: { icon: CancelCircleIcon, className: "text-red" },
  running: { icon: Loading03Icon, className: "text-orange animate-spin" },
  skipped: { icon: MinusSignCircleIcon, className: "text-ink-3" },
  neutral: { icon: CircleIcon, className: "text-ink-3" },
};

const TONE = {
  ready: { icon: Tick02Icon, badge: "bg-green-tint text-green" },
  merged: { icon: GitMergeIcon, badge: "bg-purple-tint text-purple-ink" },
  blocked: { icon: AlertCircleIcon, badge: "bg-red-tint text-red" },
  pending: { icon: Loading03Icon, badge: "bg-orange-tint text-orange" },
  closed: { icon: CancelCircleIcon, badge: "bg-hover text-ink-3" },
  draft: { icon: CircleIcon, badge: "bg-hover text-ink-2" },
} as const;

const STATE_PILL = {
  OPEN: { label: "Open", className: "bg-green-tint text-green" },
  MERGED: { label: "Merged", className: "bg-purple-tint text-purple-ink" },
  CLOSED: { label: "Closed", className: "bg-red-tint text-red" },
} as const;

const icon = (glyph: IconSvgElement, size = 14) => <HugeiconsIcon icon={glyph} size={size} strokeWidth={1.8} color="currentColor" />;

const secondary =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control border border-line px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40";

export type PullRequestPanelActions = {
  openFile: (path: string) => void;
  fixChecks: (pr: PullRequestDetail) => void;
  fixThread: (pr: PullRequestDetail, thread: PullRequestThread) => void;
  openGuide: (stop: number) => void;
  writeGuide: () => void;
};

export function PullRequestPanelBody({
  review,
  guide,
  actions,
  activePath,
  guideOpen,
  guideStop,
  local,
}: {
  review: PullRequestReview;
  guide: ReviewGuideState;
  actions: PullRequestPanelActions;
  activePath?: string;
  guideOpen: boolean;
  guideStop: number;
  /** The Worktree's uncommitted files, which the PR doesn't have yet, and what shows them (Committed when only commits are missing). */
  local?: { count: number; onOpen: (mode: "uncommitted" | "committed") => void };
}) {
  const { state, pr } = review;
  if (!pr) {
    return (
      <p data-pr-panel-notice className="px-4 py-6 text-center text-[12px] text-ink-3">
        {state.status === "error" ? state.message : "Loading the PR…"}
      </p>
    );
  }
  if (guideOpen && guide.guide) return <GuideStops pr={pr} guide={guide} current={guideStop} onOpen={actions.openGuide} onRewrite={actions.writeGuide} />;
  return (
    <ScrollArea data-pr-panel className="flex-1 pb-3">
      <Identity pr={pr} />
      <MergeCard pr={pr} review={review} />
      <div className="flex flex-col px-1">
        <ChecksRow pr={pr} onFix={() => actions.fixChecks(pr)} />
        <ReviewsRow pr={pr} onOpenFile={actions.openFile} onFix={(thread) => actions.fixThread(pr, thread)} />
        <DescriptionRow pr={pr} />
        {local && pr.state === "OPEN" && notInPrLabel(local.count, pr.localCommits ?? 0) && (
          <button
            type="button"
            data-pr-local={notInPrLabel(local.count, pr.localCommits ?? 0)}
            onClick={() => local.onOpen(local.count > 0 ? "uncommitted" : "committed")}
            className="flex h-9 w-full items-center gap-2.5 rounded-control px-3 text-left transition-colors hover:bg-hover"
          >
            <span className="flex shrink-0 text-orange">{icon(CloudUploadIcon, 15)}</span>
            <span className="shrink-0 text-[12.5px] font-medium text-ink">Not in the PR yet</span>
            <span className="min-w-0 flex-1 truncate text-right text-[11.5px] text-ink-2">{notInPrLabel(local.count, pr.localCommits ?? 0)}</span>
            <span className="shrink-0 text-ink-3">{icon(ArrowRight01Icon, 13)}</span>
          </button>
        )}
      </div>
      <GuideCard pr={pr} guide={guide} onOpen={actions.openGuide} onWrite={actions.writeGuide} />
      <Files pr={pr} review={review} activePath={activePath} onOpenFile={actions.openFile} />
    </ScrollArea>
  );
}

function Identity({ pr }: { pr: PullRequestDetail }) {
  const pill = STATE_PILL[pr.state];
  return (
    <div data-pr-identity className="flex flex-col gap-2 px-4 pt-3.5 pb-2">
      <h2 className="text-[14px] leading-[19px] font-semibold text-ink">{pr.title}</h2>
      <div className="flex min-w-0 items-center gap-2 text-[11.5px]">
        <span
          data-pr-state={pr.state}
          className={`shrink-0 rounded-full px-2 py-px font-semibold ${pr.isDraft && pr.state === "OPEN" ? "bg-hover text-ink-2" : pill.className}`}
        >
          {pr.isDraft && pr.state === "OPEN" ? "Draft" : pill.label}
        </span>
        <span className="min-w-0 truncate font-mono text-ink-3" title={`${pr.baseRefName} ← ${pr.headRefName}`}>
          {pr.baseRefName} ← {pr.headRefName}
        </span>
      </div>
    </div>
  );
}

function MergeCard({ pr, review }: { pr: PullRequestDetail; review: PullRequestReview }) {
  const status = mergeStatus(pr);
  const tone = TONE[status.tone];
  const [method, setMethod] = useState<MergeMethod>(() => readMergeMethod(pr.url));
  const [confirming, setConfirming] = useState<"merge" | "admin" | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  const action = MERGE_METHODS.find((entry) => entry.value === method) ?? MERGE_METHODS[0]!;
  const open = pr.state === "OPEN";
  const busy = review.busy !== null;
  const pickMethod = (next: MergeMethod) => {
    setMethod(next);
    saveMergeMethod(pr.url, next);
  };
  const merge = (admin = false) => {
    const step = admin ? "admin" : "merge";
    if (confirming !== step) return setConfirming(step);
    setConfirming(null);
    void review.write("merge", (bridge, cwd, number) => bridge.merge({ cwd, number, method, admin }));
  };

  let buttons: ReactNode = null;
  if (open && pr.isDraft) {
    buttons = (
      <button
        type="button"
        data-pr-ready
        disabled={busy}
        onClick={() => void review.write("ready", (bridge, cwd, number) => bridge.ready({ cwd, number }))}
        className={`${secondary} flex-1`}
      >
        Ready for review
      </button>
    );
  } else if (open && canMergeNow(pr)) {
    buttons = (
      <>
        <button
          type="button"
          data-pr-merge
          disabled={busy}
          onClick={() => merge()}
          // GitHub lets an UNSTABLE PR merge past failing optional checks; only a ready PR gets the green button.
          className={
            status.tone === "ready"
              ? "inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control bg-green px-3 text-[12.5px] font-semibold text-page transition-opacity hover:opacity-90 disabled:opacity-50"
              : `${secondary} flex-1`
          }
        >
          {icon(GitMergeIcon)}
          <span className="truncate">{review.busy === "merge" ? "Merging…" : confirming === "merge" ? "Confirm merge" : action.action}</span>
        </button>
        <Select label="Merge method" value={method} options={MERGE_METHODS} onChange={pickMethod} width={160} compact />
      </>
    );
  } else if (open && pr.autoMerge) {
    buttons = (
      <>
        <span data-pr-auto-merge className="min-w-0 flex-1 truncate text-[12px] text-ink-2">
          Merges by {pr.autoMerge.method} once it can
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void review.write("auto", (bridge, cwd, number) => bridge.merge({ cwd, number, method, disableAuto: true }))}
          className={secondary}
        >
          Turn off
        </button>
      </>
    );
  } else if (open) {
    buttons = (
      <>
        <button
          type="button"
          data-pr-auto
          disabled={busy}
          onClick={() => void review.write("auto", (bridge, cwd, number) => bridge.merge({ cwd, number, method, auto: true }))}
          className={`${secondary} flex-1`}
        >
          {icon(GitMergeIcon)}
          Merge when ready
        </button>
        {pr.viewerCanMergeAsAdmin && (
          <button type="button" data-pr-admin disabled={busy} onClick={() => merge(true)} className={secondary}>
            {confirming === "admin" ? "Confirm" : "Merge anyway"}
          </button>
        )}
      </>
    );
  }

  return (
    <div data-pr-merge-card={status.tone} className="mx-3 my-1.5 flex flex-col gap-3 rounded-card bg-inset p-3">
      <div className="flex items-center gap-2.5">
        <span className={`flex size-7 shrink-0 items-center justify-center rounded-full ${tone.badge}`}>{icon(tone.icon, 15)}</span>
        <div className="min-w-0 flex-1">
          <p data-pr-merge-title className="text-[13.5px] font-semibold text-ink">
            {status.title}
          </p>
          <p data-pr-merge-detail className="text-[11.5px] leading-4 text-ink-2">
            {status.detail}
          </p>
        </div>
        <Tooltip label="Open on GitHub" side="bottom" align="end">
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open on GitHub"
            className="flex size-7 items-center justify-center rounded-chip text-ink-3 hover:bg-hover hover:text-ink"
          >
            {icon(LinkSquare02Icon)}
          </a>
        </Tooltip>
      </div>
      {buttons && <div className="flex items-center gap-2">{buttons}</div>}
      {review.writeError && (
        <p data-pr-write-error className="text-[12px] leading-4 text-red">
          {review.writeError}
        </p>
      )}
    </div>
  );
}

function Row({
  glyph,
  glyphClass,
  label,
  value,
  open,
  onToggle,
  children,
  ...rest
}: {
  glyph: IconSvgElement;
  glyphClass: string;
  label: string;
  value: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
} & Record<`data-${string}`, string>) {
  return (
    <div {...rest}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-9 w-full items-center gap-2.5 rounded-control px-3 text-left transition-colors hover:bg-hover"
      >
        <span className={`flex shrink-0 ${glyphClass}`}>{icon(glyph, 15)}</span>
        <span className="shrink-0 text-[12.5px] font-medium text-ink">{label}</span>
        <span className="min-w-0 flex-1 truncate text-right text-[11.5px] text-ink-2">{value}</span>
        <span className="shrink-0 text-ink-3">{icon(open ? ArrowDown01Icon : ArrowRight01Icon, 13)}</span>
      </button>
      {open && <div className="px-3 pt-1 pb-2">{children}</div>}
    </div>
  );
}

function ChecksRow({ pr, onFix }: { pr: PullRequestDetail; onFix: () => void }) {
  const [open, setOpen] = useState(false);
  const outcome = checksOutcome(pr.checks);
  const shown = outcome ? CHECK_ICON[outcome] : CHECK_ICON.neutral;
  return (
    <Row
      data-pr-checks=""
      glyph={shown.icon}
      glyphClass={shown.className.replace("animate-spin", "")}
      label="Checks"
      value={checksSummary(pr.checks) || "None"}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <div className="flex flex-col gap-0.5">
        {pr.checks.map((check, index) => (
          <a
            key={`${check.name}-${index}`}
            data-pr-check={check.outcome}
            href={check.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-6 items-center gap-2 rounded-chip px-1 text-[12px] text-ink-2 no-underline hover:bg-hover hover:text-ink"
          >
            <span className={`flex shrink-0 ${CHECK_ICON[check.outcome].className}`}>{icon(CHECK_ICON[check.outcome].icon, 13)}</span>
            <span className="min-w-0 flex-1 truncate">
              {check.workflow && <span className="text-ink-3">{check.workflow} / </span>}
              {check.name}
            </span>
          </a>
        ))}
        {outcome === "fail" && (
          <button
            type="button"
            data-pr-fix-checks
            onClick={onFix}
            className="mt-1 inline-flex h-7 items-center gap-1.5 self-start rounded-control px-1 text-[12px] font-semibold text-accent-ink hover:bg-hover"
          >
            {icon(SparklesIcon, 13)}
            Fix in Chat
          </button>
        )}
      </div>
    </Row>
  );
}

function ReviewsRow({ pr, onOpenFile, onFix }: { pr: PullRequestDetail; onOpenFile: (path: string) => void; onFix: (thread: PullRequestThread) => void }) {
  const [open, setOpen] = useState(false);
  const threads = openThreads(pr);
  const approved = pr.reviewers.filter((reviewer) => reviewer.state === "APPROVED" && !reviewer.stale).length;
  const value = threads.length
    ? `${threads.length} open thread${threads.length === 1 ? "" : "s"}`
    : approved
      ? `${approved} approval${approved === 1 ? "" : "s"}`
      : pr.reviewers.length
        ? `${pr.reviewers.length} reviewer${pr.reviewers.length === 1 ? "" : "s"}`
        : "None yet";
  const glyphClass = pr.reviewDecision === "CHANGES_REQUESTED" ? "text-red" : threads.length ? "text-orange" : approved ? "text-green" : "text-ink-3";
  return (
    <Row
      data-pr-reviews=""
      glyph={UserCheck01Icon}
      glyphClass={glyphClass}
      label="Reviews"
      value={value}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <div className="flex flex-col gap-1">
        {pr.reviewers.map((reviewer) => (
          <div
            key={reviewer.login}
            data-pr-reviewer={reviewer.state}
            className={`flex h-6 items-center gap-2 px-1 text-[12px] ${reviewer.stale ? "opacity-60" : ""}`}
          >
            <span className="min-w-0 flex-1 truncate text-ink">{reviewer.login}</span>
            <span className={reviewer.state === "APPROVED" ? "text-green" : reviewer.state === "CHANGES_REQUESTED" ? "text-red" : "text-ink-3"}>
              {
                { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENTED: "Commented", REQUESTED: "Requested", DISMISSED: "Dismissed" }[
                  reviewer.state
                ]
              }
            </span>
          </div>
        ))}
        {threads.map((thread) => (
          <div key={thread.id} data-pr-open-thread={thread.id} className="flex flex-col gap-1 rounded-control bg-inset p-2">
            <button
              type="button"
              onClick={() => onOpenFile(thread.path)}
              className="truncate text-left font-mono text-[11px] text-ink-3 hover:text-ink"
              dir="rtl"
            >
              <bdi>
                {thread.path}
                {thread.line ? `:${thread.line}` : ""}
              </bdi>
            </button>
            <p className="line-clamp-2 text-[12px] text-ink">
              <span className="font-medium">{thread.comments[0]?.author}</span> {thread.comments[0]?.body}
            </p>
            <button
              type="button"
              onClick={() => onFix(thread)}
              className="inline-flex items-center gap-1 self-start text-[11.5px] font-semibold text-accent-ink hover:underline"
            >
              {icon(SparklesIcon, 12)}
              Fix in Chat
            </button>
          </div>
        ))}
      </div>
    </Row>
  );
}

function DescriptionRow({ pr }: { pr: PullRequestDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <Row
      data-pr-description=""
      glyph={Comment01Icon}
      glyphClass="text-ink-2"
      label="Description"
      value={`${pr.commits.length} commit${pr.commits.length === 1 ? "" : "s"}`}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <div className="text-[12.5px] text-ink-2">{pr.body.trim() ? <Markdown text={pr.body} /> : <p className="text-ink-3">No description.</p>}</div>
    </Row>
  );
}

function GuideCard({ pr, guide, onOpen, onWrite }: { pr: PullRequestDetail; guide: ReviewGuideState; onOpen: (stop: number) => void; onWrite: () => void }) {
  const written = guide.guide;
  const risks = written?.stops.filter((stop) => stop.attention).length ?? 0;
  const stale = written ? guideStale(written, pr) : false;
  const error = guide.result?.ok === false ? guide.result.message : guide.result?.ok ? guide.result.error : undefined;
  let detail: string;
  if (guide.writing) detail = "An agent is reading the change…";
  else if (written) {
    const parts = [`${written.stops.length} stops`, risks ? `${risks} to judge` : "", guide.read.length ? `${guide.read.length} read` : ""].filter(Boolean);
    detail = stale ? "Written before the latest push" : parts.join(" · ");
  } else detail = "A short tour of this PR, in reading order";
  return (
    <div
      data-pr-guide-card={guide.writing ? "writing" : written ? (stale ? "stale" : "ready") : "none"}
      className="mx-3 my-2 flex flex-col gap-2 rounded-card border border-accent/25 bg-accent-tint p-3"
    >
      <div className="flex items-center gap-2.5">
        <span className={`flex shrink-0 text-accent-ink ${guide.writing ? "animate-pulse" : ""}`}>{icon(SparklesIcon, 17)}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-ink">Review guide</p>
          <p className={`truncate text-[11px] ${stale ? "text-orange" : "text-ink-2"}`}>{detail}</p>
        </div>
        {written && !guide.writing && (
          <button
            type="button"
            data-pr-guide-start
            onClick={() => onOpen(nextStop(written, guide.read))}
            className="h-7 shrink-0 rounded-control bg-accent px-3 text-[12px] font-semibold text-white hover:opacity-90"
          >
            {guide.read.length ? "Continue" : "Start"}
          </button>
        )}
        {!written && !guide.writing && (
          <button
            type="button"
            data-pr-guide-write
            onClick={onWrite}
            className="h-7 shrink-0 rounded-control bg-accent px-3 text-[12px] font-semibold text-white hover:opacity-90"
          >
            Write guide
          </button>
        )}
        {written && !guide.writing && (
          <Tooltip label="Rewrite the guide" side="bottom" align="end">
            <button
              type="button"
              aria-label="Rewrite the guide"
              data-pr-guide-rewrite
              onClick={onWrite}
              className="flex size-7 shrink-0 items-center justify-center rounded-chip text-ink-3 hover:bg-hover hover:text-ink"
            >
              {icon(RefreshIcon, 13)}
            </button>
          </Tooltip>
        )}
      </div>
      {error && !guide.writing && <p className="text-[11.5px] text-red">{error}</p>}
    </div>
  );
}

type Entry = PullRequestFile & { added: number; removed: number };

function Files({
  pr,
  review,
  activePath,
  onOpenFile,
}: {
  pr: PullRequestDetail;
  review: PullRequestReview;
  activePath?: string;
  onOpenFile: (path: string) => void;
}) {
  const tree = useMemo(() => buildDiffTree<Entry>(pr.files.map((file) => ({ ...file, added: file.additions, removed: file.deletions }))), [pr.files]);
  const threads = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of openThreads(pr)) counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
    return counts;
  }, [pr]);
  const { viewed, total } = viewedCount(pr);
  const toggle = (file: PullRequestFile) => {
    const next = file.viewed !== "VIEWED";
    void review.write(
      "viewed",
      (bridge, cwd, number) => bridge.fileViewed({ cwd, number, path: file.path, viewed: next }),
      (current) => ({
        ...current,
        files: current.files.map((entry) => (entry.path === file.path ? { ...entry, viewed: next ? "VIEWED" : "UNVIEWED" } : entry)),
      }),
    );
  };
  return (
    <div data-pr-files className="mt-1 flex flex-col">
      <div className="flex flex-col gap-2 px-4 pt-2 pb-2">
        <div className="flex items-center justify-between text-[11.5px]">
          <span className="font-semibold text-ink-2">
            Files <span className="font-normal text-ink-3 tabular-nums">{total}</span>
          </span>
          <span data-pr-viewed-count className="text-ink-3 tabular-nums">
            {viewed} of {total} viewed
          </span>
        </div>
        <div className="h-[3px] overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-green transition-[width] duration-300" style={{ width: total ? `${(viewed / total) * 100}%` : 0 }} />
        </div>
      </div>
      <FileTree nodes={tree} depth={0} activePath={activePath} threads={threads} onOpenFile={onOpenFile} onToggle={toggle} />
    </div>
  );
}

type TreeProps = { activePath?: string; threads: Map<string, number>; onOpenFile: (path: string) => void; onToggle: (file: PullRequestFile) => void };

function FileTree({ nodes, depth, ...rest }: { nodes: DiffTreeNode<Entry>[]; depth: number } & TreeProps) {
  return (
    <>
      {nodes.map((node) => (
        <FileNode key={node.path} node={node} depth={depth} {...rest} />
      ))}
    </>
  );
}

function FileNode({ node, depth, activePath, threads, onOpenFile, onToggle }: { node: DiffTreeNode<Entry>; depth: number } & TreeProps) {
  const [collapsed, setCollapsed] = useState(false);
  const indent = { paddingLeft: 12 + depth * 12 };
  if (node.type === "folder") {
    return (
      <>
        <button
          type="button"
          data-pr-folder={node.path}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          style={indent}
          className="flex h-7 w-full items-center gap-1.5 pr-3 text-left text-[12px] hover:bg-hover"
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">{icon(collapsed ? ArrowRight01Icon : ArrowDown01Icon, 13)}</span>
          <span className="min-w-0 flex-1 truncate text-ink-3" dir="rtl">
            <bdi>{node.name}</bdi>
          </span>
        </button>
        {!collapsed && (
          <FileTree nodes={node.children} depth={depth + 1} activePath={activePath} threads={threads} onOpenFile={onOpenFile} onToggle={onToggle} />
        )}
      </>
    );
  }
  const file = node.file;
  const viewed = file.viewed === "VIEWED";
  const count = threads.get(file.path);
  return (
    <div
      style={indent}
      data-pr-file={file.path}
      aria-current={activePath === file.path}
      className={`group flex h-7 w-full items-center gap-1.5 pr-2 text-[12.5px] hover:bg-hover ${activePath === file.path ? "bg-hover" : ""}`}
    >
      <button type="button" onClick={() => onOpenFile(file.path)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">{icon(File01Icon, 14)}</span>
        <span className={`min-w-0 flex-1 truncate ${viewed ? "text-ink-3" : "text-ink"}`}>{node.name}</span>
        {count ? (
          <span
            data-pr-file-threads={count}
            aria-label={`${count} open threads`}
            className="flex shrink-0 items-center gap-0.5 text-[11px] text-orange tabular-nums"
          >
            {icon(Comment01Icon, 12)}
            {count}
          </span>
        ) : null}
        <Counts added={file.additions} removed={file.deletions} className={viewed ? "opacity-60" : ""} />
      </button>
      <Tooltip label={viewed ? "Mark as not viewed" : file.viewed === "DISMISSED" ? "Changed since you viewed it" : "Mark as viewed"} side="bottom" align="end">
        <button
          type="button"
          aria-label={viewed ? "Viewed" : "Not viewed"}
          aria-pressed={viewed}
          data-pr-file-viewed={file.viewed}
          onClick={() => onToggle(file)}
          className={`flex size-6 shrink-0 items-center justify-center rounded-chip ${viewed ? "text-green" : file.viewed === "DISMISSED" ? "text-orange" : "text-ink-3 hover:text-ink"}`}
        >
          {icon(viewed ? CheckmarkCircle02Icon : file.viewed === "DISMISSED" ? EyeIcon : CircleIcon, 14)}
        </button>
      </Tooltip>
    </div>
  );
}

const KIND_LABEL: Record<GuideStop["kind"], string> = { contract: "Contract", implementation: "Implementation", ui: "UI", tests: "Tests", config: "Config" };

function fileCount(stop: GuideStop) {
  const count = new Set([...stop.excerpts.map((excerpt) => excerpt.path), ...stop.files.map((file) => file.path)]).size;
  return `${count} file${count === 1 ? "" : "s"}`;
}

function GuideStops({
  pr,
  guide,
  current,
  onOpen,
  onRewrite,
}: {
  pr: PullRequestDetail;
  guide: ReviewGuideState;
  current: number;
  onOpen: (stop: number) => void;
  onRewrite: () => void;
}) {
  const written = guide.guide!;
  const stale = guideStale(written, pr);
  return (
    <ScrollArea data-pr-guide-stops className="flex-1 pb-3">
      <div className="flex flex-col gap-2 px-4 pt-3.5 pb-2">
        <div className="flex items-center gap-2">
          <span className="flex text-accent-ink">{icon(SparklesIcon, 15)}</span>
          <span className="flex-1 text-[13.5px] font-semibold text-ink">Review guide</span>
          <span className="text-[11.5px] text-ink-2 tabular-nums">
            {guide.read.length} of {written.stops.length} read
          </span>
        </div>
        <p className="text-[11px] text-ink-3">
          {providerName(written.provider as ModelProvider)} wrote it for <span className="font-mono">{written.headRefOid.slice(0, 7)}</span>
        </p>
        {stale && (
          <button type="button" onClick={onRewrite} className="self-start text-[11.5px] font-medium text-orange hover:underline">
            Written before the latest push · Rewrite
          </button>
        )}
        <div className="h-[3px] overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-green" style={{ width: `${(guide.read.length / written.stops.length) * 100}%` }} />
        </div>
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        {written.stops.map((stop, index) => {
          const read = guide.read.includes(index);
          return (
            <button
              key={index}
              type="button"
              data-pr-guide-stop={index}
              aria-current={index === current}
              onClick={() => onOpen(index)}
              className={`flex items-start gap-2.5 rounded-control p-2.5 text-left transition-colors ${index === current ? "bg-hover" : "hover:bg-hover"}`}
            >
              <span
                className={`flex size-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                  index === current ? "bg-accent text-white" : read ? "bg-green-tint text-green" : "border border-line text-ink-2"
                }`}
              >
                {read && index !== current ? icon(Tick02Icon, 12) : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[12.5px] font-medium ${read && index !== current ? "text-ink-2" : "text-ink"}`}>{stop.title}</span>
                <span className="block truncate text-[11px] text-ink-3">
                  {KIND_LABEL[stop.kind]} · {fileCount(stop)}
                </span>
              </span>
              {stop.attention && <span className="mt-0.5 flex shrink-0 text-orange">{icon(EyeIcon, 13)}</span>}
            </button>
          );
        })}
      </div>
      {written.notCovered.length > 0 && (
        <div className="mx-4 mt-3 flex flex-col gap-1">
          <p className="text-[11.5px] font-semibold text-ink-2">Not in the tour</p>
          <p className="text-[11px] break-words text-ink-3">{written.notCovered.join(", ")}</p>
        </div>
      )}
    </ScrollArea>
  );
}

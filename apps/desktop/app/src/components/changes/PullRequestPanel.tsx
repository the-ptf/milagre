import { useEffect, useMemo, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUpDownIcon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  CloudUploadIcon,
  Comment01Icon,
  File01Icon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LinkSquare02Icon,
  Loading03Icon,
  MinusSignCircleIcon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import {
  canMergeNow,
  checksProgress,
  mergeStatus,
  notInPrLabel,
  openThreads,
  type MergeMethod,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestFile,
  type PullRequestThread,
} from "@milagre/shared/pull-request-review";
import { buildDiffTree, type DiffTreeNode } from "../../lib/diff-tree";
import { age, MERGE_METHODS, readMergeMethod, repoOf, saveMergeMethod } from "../../lib/pull-request-view";
import { prImageLoader } from "../../lib/pr-images";
import { Markdown, type MarkdownImageLoader } from "../markdown/Markdown";
import { PickerPanel, PickerRow } from "../primitives/Picker";
import { ScrollArea } from "../primitives/ScrollArea";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { ProjectAvatarStack } from "../ProjectAvatarStack";
import { Counts, moveTab } from "./ChangesPanel";
import { PopoverButton } from "./pr/Popover";
import { Avatar, LabelsRow, ReviewersRow, type PrSource } from "./pr/Properties";
import type { PullRequestReview } from "./usePullRequest";

// The Changes panel's tab for a PR the Chat opened: its header and merge button, then Summary (reviewers, labels,
// description, checks, comments) and Files. Files and threads open in the main column's diff.

export type { PrSource };

const CHECK_ICON: Record<PullRequestCheck["outcome"], { icon: IconSvgElement; className: string }> = {
  pass: { icon: CheckmarkCircle02Icon, className: "text-green-ink" },
  fail: { icon: CancelCircleIcon, className: "text-red-ink" },
  running: { icon: Loading03Icon, className: "text-orange-ink animate-spin" },
  skipped: { icon: MinusSignCircleIcon, className: "text-ink-3" },
  neutral: { icon: CircleIcon, className: "text-ink-3" },
};
// Failing checks first, then the ones still running.
const CHECK_ORDER: Record<PullRequestCheck["outcome"], number> = { fail: 0, running: 1, pass: 2, neutral: 3, skipped: 4 };

/** Draft, Merged or Closed before the author, as GitHub shows it; the phone shows the same pill. An open PR has none. */
const STATE_PILL = {
  draft: { label: "Draft", icon: GitPullRequestDraftIcon, className: "bg-hover text-ink-2" },
  MERGED: { label: "Merged", icon: GitMergeIcon, className: "bg-purple-tint text-purple-ink" },
  CLOSED: { label: "Closed", icon: GitPullRequestClosedIcon, className: "bg-red-tint text-red-ink" },
} as const;

/** The line under the branch: what stops an open PR, or how a merged or closed one ended. The phone words it the same. */
const STATUS_LINE: Partial<Record<ReturnType<typeof mergeStatus>["tone"], { icon: IconSvgElement; ink: string; title: string }>> = {
  blocked: { icon: AlertCircleIcon, ink: "text-red-ink", title: "text-red-ink" },
  draft: { icon: GitPullRequestDraftIcon, ink: "text-ink-3", title: "text-ink" },
  merged: { icon: GitMergeIcon, ink: "text-purple-ink", title: "text-purple-ink" },
  closed: { icon: GitPullRequestClosedIcon, ink: "text-red-ink", title: "text-red-ink" },
};

const icon = (glyph: IconSvgElement, size = 14) => <HugeiconsIcon icon={glyph} size={size} strokeWidth={1.8} color="currentColor" />;

const secondary =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-control border border-line-strong px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-hover disabled:opacity-40";
const iconButton = "flex size-7 shrink-0 items-center justify-center rounded-control text-ink-2 transition-colors hover:bg-hover hover:text-ink";

const ago = (iso: string) => {
  const text = age(iso);
  return text === "now" ? "just now" : text ? `${text} ago` : "";
};

export type PullRequestPanelActions = { openFile: (path: string) => void };

export function PullRequestPanelBody({
  review,
  source,
  actions,
  activePath,
  local,
  project,
}: {
  review: PullRequestReview;
  /** Where the reviewer and label pickers read their options; without it they offer only what the PR has. */
  source?: PrSource;
  actions: PullRequestPanelActions;
  activePath?: string;
  /** The Worktree's uncommitted files, which the PR doesn't have yet, and what shows them. */
  local?: { count: number; onOpen: () => void };
  /** A Link Chat's PR names the Project it belongs to. */
  project?: { name: string; path: string };
}) {
  const [tab, setTab] = useState<"summary" | "files">("summary");
  const { state, pr } = review;
  if (!pr) {
    return (
      <p data-pr-panel-notice className="px-4 py-6 text-center text-[12px] text-ink-3">
        {state.status === "error" ? state.message : "Loading the PR…"}
      </p>
    );
  }
  return (
    <ScrollArea data-pr-panel className="flex-1 pb-3">
      <Header key={pr.url} pr={pr} review={review} local={local} project={project} />
      <div className="h-px bg-line" />
      <Tabs pr={pr} tab={tab} onTab={setTab} />
      {tab === "summary" ? (
        // A Link Chat's PR tabs share this panel: another repository's PR starts with fresh pickers.
        <Summary key={`${pr.url}\0${source?.cwd ?? ""}`} pr={pr} review={review} source={source} onOpenFile={actions.openFile} />
      ) : (
        <Files pr={pr} activePath={activePath} onOpenFile={actions.openFile} />
      )}
    </ScrollArea>
  );
}

function Header({
  pr,
  review,
  local,
  project,
}: {
  pr: PullRequestDetail;
  review: PullRequestReview;
  local?: { count: number; onOpen: () => void };
  project?: { name: string; path: string };
}) {
  const [method, setMethod] = useState<MergeMethod>(() => readMergeMethod(pr.url));
  const [confirming, setConfirming] = useState<"merge" | "admin" | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  const open = pr.state === "OPEN";
  const busy = review.busy !== null;
  const pill = pr.state !== "OPEN" ? STATE_PILL[pr.state] : pr.isDraft ? STATE_PILL.draft : null;
  const notInPr = local && open ? notInPrLabel(local.count, pr.localCommits ?? 0) : "";
  const status = mergeStatus(pr);
  const line = STATUS_LINE[status.tone];
  // GitHub can't merge a conflicting PR, not even later or as an admin.
  const conflicts = pr.mergeStateStatus === "DIRTY";
  const merge = (admin = false) => {
    const step = admin ? "admin" : "merge";
    if (confirming !== step) return setConfirming(step);
    setConfirming(null);
    void review.write("merge", (bridge, cwd, number) => bridge.merge({ cwd, number, method, admin }));
  };
  const auto = (on: boolean) =>
    void review.write("auto", (bridge, cwd, number) => bridge.merge({ cwd, number, method, ...(on ? { auto: true } : { disableAuto: true }) }));

  let primary: ReactNode = null;
  if (open && pr.isDraft) {
    primary = (
      <button
        type="button"
        data-pr-ready
        disabled={busy}
        onClick={() => void review.write("ready", (bridge, cwd, number) => bridge.ready({ cwd, number }))}
        className={secondary}
      >
        Ready for review
      </button>
    );
  } else if (open && canMergeNow(pr)) {
    primary = (
      <button
        type="button"
        data-pr-merge
        disabled={busy}
        onClick={() => merge()}
        // GitHub lets an UNSTABLE PR merge past failing optional checks; only a ready PR gets the green button.
        className={
          status.tone === "ready"
            ? "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-control bg-green px-3 text-[12px] font-semibold text-page transition-opacity hover:opacity-90 disabled:opacity-50"
            : secondary
        }
      >
        {icon(GitMergeIcon, 13)}
        {review.busy === "merge" ? "Merging…" : confirming === "merge" ? "Confirm merge" : "Merge"}
      </button>
    );
  } else if (open && pr.autoMerge) {
    primary = (
      <span data-pr-auto-merge className="inline-flex h-7 shrink-0 items-center gap-1.5 px-1 text-[12px] text-ink-2">
        {icon(GitMergeIcon, 13)}
        <span className="@max-[308px]:hidden">Merges when ready</span>
        <span className="hidden @max-[308px]:inline">Auto-merge on</span>
      </span>
    );
  } else if (open && !conflicts) {
    primary = (
      <button type="button" data-pr-auto disabled={busy} onClick={() => auto(true)} className={secondary}>
        {icon(GitMergeIcon, 13)}
        <span className="@max-[308px]:hidden">Merge when ready</span>
        <span className="hidden @max-[308px]:inline">Auto-merge</span>
      </button>
    );
  }

  // Container widths are the header's content box: 308px is a 340px panel, where the merge button shortens its label.
  return (
    <div data-pr-identity data-pr-state={pr.state} className="@container flex flex-col gap-2 px-4 pt-3 pb-3.5">
      <div className="flex min-w-0 items-center gap-2">
        {project && (
          <span data-pr-project={project.name} className="flex shrink-0">
            <ProjectAvatarStack projects={[project]} />
          </span>
        )}
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          data-pr-link
          className="flex min-w-0 items-center gap-1 text-[12px] text-ink-2 no-underline hover:text-ink"
        >
          {/* The first thing to go when the row is narrow; the number always shows. */}
          <span className="truncate @max-[264px]:hidden">{repoOf(pr.url) ?? project?.name}</span>
          <span className="shrink-0 text-accent-ink">#{pr.number}</span>
          <span className="flex shrink-0 text-accent-ink">{icon(LinkSquare02Icon, 11)}</span>
        </a>
        <span className="flex-1" />
        {primary}
        <PopoverButton
          data-pr-more
          label="More actions"
          className={iconButton}
          width={220}
          renderPanel={(close) => (
            <PickerPanel className="min-h-0">
              {open && !pr.isDraft && !canMergeNow(pr) && !conflicts && pr.viewerCanMergeAsAdmin && (
                <PickerRow
                  label={confirming === "admin" ? "Confirm merge anyway" : "Merge anyway"}
                  description="Skips the rules that block it"
                  selected={false}
                  disabled={busy}
                  onClick={() => {
                    if (confirming === "admin") close();
                    merge(true);
                  }}
                />
              )}
              {open && pr.autoMerge && (
                <PickerRow
                  label="Turn off auto-merge"
                  selected={false}
                  disabled={busy}
                  onClick={() => {
                    close();
                    auto(false);
                  }}
                />
              )}
              {open && !pr.isDraft && (
                <>
                  <div className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-ink-3 uppercase">Merge method</div>
                  {MERGE_METHODS.map((entry) => (
                    <PickerRow
                      key={entry.value}
                      label={entry.label}
                      selected={entry.value === method}
                      onClick={() => {
                        setMethod(entry.value);
                        saveMergeMethod(pr.url, entry.value);
                      }}
                      option
                    />
                  ))}
                  <div className="mx-2 my-1 h-px bg-line" />
                  <PickerRow
                    label="Convert to draft"
                    selected={false}
                    disabled={busy}
                    onClick={() => {
                      close();
                      void review.write("ready", (bridge, cwd, number) => bridge.ready({ cwd, number, draft: true }));
                    }}
                  />
                  <div className="mx-2 my-1 h-px bg-line" />
                </>
              )}
              <PickerRow
                label="Open on GitHub"
                selected={false}
                onClick={() => {
                  close();
                  window.open(pr.url, "_blank", "noopener,noreferrer");
                }}
              />
              <PickerRow
                label="Copy link"
                selected={false}
                onClick={() => {
                  close();
                  void navigator.clipboard.writeText(pr.url).catch(() => {});
                }}
              />
            </PickerPanel>
          )}
        >
          {icon(MoreHorizontalIcon, 16)}
        </PopoverButton>
      </div>
      <h2 className="text-[15px] leading-5 font-semibold text-ink">{pr.title}</h2>
      <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
        {pill && (
          <span
            data-pr-state-pill={pill.label}
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-[11px] font-semibold ${pill.className}`}
          >
            {icon(pill.icon, 11)}
            {pill.label}
          </span>
        )}
        <Avatar login={pr.author} size={18} />
        <span className="shrink-0 text-[12.5px] font-semibold text-ink">{pr.author}</span>
        <span className="min-w-0 truncate text-ink-3">· updated {ago(pr.updatedAt)}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
        <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-3" title={`${pr.baseRefName} ← ${pr.headRefName}`}>
          <span className="text-ink-2">{pr.baseRefName}</span> ← {pr.headRefName}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 text-ink-2">
          {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
        </span>
        <Counts added={pr.additions} removed={pr.deletions} />
      </div>
      {line && (
        <div data-pr-status={status.title} className="flex min-w-0 items-start gap-1.5 text-[12px] leading-4">
          <span className={`flex h-4 shrink-0 items-center ${line.ink}`}>{icon(line.icon, 13)}</span>
          {/* Wraps rather than cutting the base branch off in a narrow panel. */}
          <span className="line-clamp-2 min-w-0 text-ink-2">
            <span className={`font-semibold ${line.title}`}>{status.title}</span> · {status.detail}
          </span>
        </div>
      )}
      {notInPr && (
        <button
          type="button"
          data-pr-local={notInPr}
          onClick={local?.onOpen}
          className="-mx-1 flex min-w-0 items-center gap-1.5 self-start rounded-chip px-1 text-left text-[12px] text-orange-ink hover:bg-hover"
        >
          <span className="flex shrink-0">{icon(CloudUploadIcon, 13)}</span>
          <span className="truncate">{notInPr.replace(" · ", " and ")} not in the PR yet</span>
          <span className="flex shrink-0">{icon(ArrowRight01Icon, 12)}</span>
        </button>
      )}
      {review.writeError && (
        <p data-pr-write-error className="text-[12px] leading-4 text-red-ink">
          {review.writeError}
        </p>
      )}
    </div>
  );
}

const SEGMENTS = [
  { key: "passed", className: "bg-green" },
  { key: "skipped", className: "bg-ink-3/40" },
  { key: "failed", className: "bg-red" },
  { key: "running", className: "bg-orange/40 motion-safe:animate-pulse" },
] as const;

const tabClass = (on: boolean) =>
  `flex h-6 items-center gap-1.5 rounded-[6px] px-3 text-[12.5px] transition-colors ${on ? "bg-hover font-semibold text-ink" : "text-ink-2 hover:text-ink"}`;

function Tabs({ pr, tab, onTab }: { pr: PullRequestDetail; tab: "summary" | "files"; onTab: (tab: "summary" | "files") => void }) {
  const progress = checksProgress(pr.checks);
  return (
    <div className="flex flex-col gap-2 px-3.5 pt-3 pb-1">
      {/* The checks status wraps under the tabs when they don't fit side by side. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <div role="tablist" aria-label="Pull request" onKeyDown={moveTab} className="flex shrink-0 items-center gap-0.5 rounded-control bg-inset p-[3px]">
          <button
            type="button"
            role="tab"
            data-pr-tab="summary"
            aria-selected={tab === "summary"}
            tabIndex={tab === "summary" ? 0 : -1}
            onClick={() => onTab("summary")}
            className={tabClass(tab === "summary")}
          >
            Summary
          </button>
          <button
            type="button"
            role="tab"
            data-pr-tab="files"
            aria-selected={tab === "files"}
            tabIndex={tab === "files" ? 0 : -1}
            onClick={() => onTab("files")}
            className={tabClass(tab === "files")}
          >
            Files <span className="text-[11.5px] font-normal text-ink-3 tabular-nums">{pr.changedFiles}</span>
          </button>
        </div>
        {progress.label && (
          <span
            data-pr-checks-status={progress.tone}
            className={`ml-auto flex items-center gap-1.5 text-[12px] whitespace-nowrap ${progress.tone === "fail" ? "text-red-ink" : progress.tone === "pass" ? "text-green-ink" : "text-ink-2"}`}
          >
            {progress.tone === "running" ? (
              <SpinnerRing size={13} color="var(--orange)" />
            ) : (
              icon(progress.tone === "fail" ? CancelCircleIcon : CheckmarkCircle02Icon, 13)
            )}
            <span className="tabular-nums">{progress.label}</span>
          </span>
        )}
      </div>
      {progress.total > 0 && (
        <div data-pr-checks-bar className="flex h-[3px] gap-0.5" aria-hidden>
          {SEGMENTS.map(({ key, className }) =>
            progress[key] ? <span key={key} data-pr-checks-segment={key} className={`rounded-full ${className}`} style={{ flexGrow: progress[key] }} /> : null,
          )}
        </div>
      )}
    </div>
  );
}

function Summary({
  pr,
  review,
  source,
  onOpenFile,
}: {
  pr: PullRequestDetail;
  review: PullRequestReview;
  source?: PrSource;
  onOpenFile: (path: string) => void;
}) {
  const [newest, setNewest] = useState(true);
  const comments = useMemo(() => {
    const items = [
      ...openThreads(pr).map((thread) => ({ thread, comments: thread.comments.filter((comment) => !comment.pending) })),
      ...pr.comments.filter((comment) => !comment.pending).map((comment) => ({ thread: undefined, comments: [comment] })),
    ];
    // By the latest word in each.
    const at = (item: (typeof items)[number]) => Date.parse(item.comments.at(-1)?.createdAt ?? "") || 0;
    return items.toSorted((a, b) => (newest ? at(b) - at(a) : at(a) - at(b)));
  }, [pr, newest]);
  const checks = useMemo(() => pr.checks.toSorted((a, b) => CHECK_ORDER[a.outcome] - CHECK_ORDER[b.outcome]), [pr.checks]);
  const loadImage = useMemo(() => (source ? prImageLoader(source.bridge, source.cwd) : undefined), [source]);
  return (
    <>
      <div className="flex flex-col px-4 py-2">
        <ReviewersRow pr={pr} review={review} source={source} />
        <LabelsRow pr={pr} review={review} source={source} />
      </div>
      <div className="h-px bg-line" />
      <div className="flex flex-col px-2 pt-1.5">
        <Section data-pr-description="" label="Description">
          <div className="text-[12.5px] text-ink-2">
            {pr.body.trim() ? <Markdown text={pr.body} html loadImage={loadImage} /> : <p className="text-ink-3">No description.</p>}
          </div>
        </Section>
        <Section data-pr-checks="" label="Checks" meta={pr.checks.length ? undefined : "None"}>
          <div className="flex flex-col gap-0.5">
            {checks.map((check, index) => (
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
                {check.url && <span className="flex shrink-0 text-ink-3">{icon(LinkSquare02Icon, 11)}</span>}
              </a>
            ))}
          </div>
        </Section>
        <Section
          data-pr-comments=""
          label="Comments"
          meta={String(comments.length)}
          defaultOpen
          action={
            comments.length > 1 && (
              <button
                type="button"
                data-pr-comments-sort={newest ? "newest" : "oldest"}
                onClick={() => setNewest((value) => !value)}
                className="flex shrink-0 items-center gap-1 rounded-chip px-1 text-[12px] text-ink-3 hover:bg-hover hover:text-ink"
              >
                {icon(ArrowUpDownIcon, 12)}
                {newest ? "Newest first" : "Oldest first"}
              </button>
            )
          }
        >
          {comments.length ? (
            <div className="flex flex-col gap-2">
              {comments.map((item) =>
                item.thread ? (
                  <CommentCard key={item.thread.id} thread={item.thread} comments={item.comments} onOpenFile={onOpenFile} loadImage={loadImage} />
                ) : (
                  <CommentCard key={item.comments[0]!.id} comments={item.comments} onOpenFile={onOpenFile} loadImage={loadImage} />
                ),
              )}
            </div>
          ) : (
            <p className="px-1 text-[12px] text-ink-3">No comments yet.</p>
          )}
        </Section>
      </div>
    </>
  );
}

function Section({
  label,
  meta,
  defaultOpen = false,
  action,
  children,
  ...rest
}: {
  label: string;
  meta?: string;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
} & Record<`data-${string}`, string>) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div {...rest}>
      <div className="flex h-[34px] items-center gap-2 px-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left text-ink-2 hover:text-ink"
        >
          <span className="flex shrink-0 text-ink-3">{icon(open ? ArrowDown01Icon : ArrowRight01Icon, 12)}</span>
          <span className="shrink-0 text-[12.5px] font-medium">{label}</span>
          {meta && <span className="min-w-0 truncate text-[12px] text-ink-3">{meta}</span>}
        </button>
        {open && action}
      </div>
      {open && <div className="px-1.5 pb-2.5">{children}</div>}
    </div>
  );
}

/** A comment on the PR, or an open thread on a line with its replies; the thread's place opens the file's diff. */
function CommentCard({
  thread,
  comments,
  onOpenFile,
  loadImage,
}: {
  thread?: PullRequestThread;
  comments: PullRequestComment[];
  onOpenFile: (path: string) => void;
  loadImage?: MarkdownImageLoader;
}) {
  return (
    <article
      data-pr-open-thread={thread?.id}
      data-pr-comment={thread ? undefined : comments[0]?.id}
      className="flex flex-col gap-2 rounded-card border border-line bg-inset p-3"
    >
      {comments.map((comment, index) => (
        <div key={comment.id} className={`flex flex-col gap-1.5 ${index ? "border-t border-line pt-2" : ""}`}>
          <div className="flex min-w-0 items-center gap-1.5">
            <Avatar login={comment.author} size={18} />
            <span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">{comment.author}</span>
            <span className="shrink-0 text-[12px] text-ink-3">{ago(comment.createdAt)}</span>
          </div>
          {index === 0 && thread && (
            <button
              type="button"
              data-pr-thread-path={thread.path}
              onClick={() => onOpenFile(thread.path)}
              className="truncate text-left font-mono text-[11.5px] text-ink-3 hover:text-ink"
              dir="rtl"
            >
              <bdi>
                {thread.path}
                {thread.line ? `:${thread.line}` : ""}
              </bdi>
            </button>
          )}
          <div className="text-[12.5px] text-ink">
            <Markdown text={comment.body} html loadImage={loadImage} />
          </div>
        </div>
      ))}
    </article>
  );
}

type Entry = PullRequestFile & { added: number; removed: number };

function Files({ pr, activePath, onOpenFile }: { pr: PullRequestDetail; activePath?: string; onOpenFile: (path: string) => void }) {
  const tree = useMemo(() => buildDiffTree<Entry>(pr.files.map((file) => ({ ...file, added: file.additions, removed: file.deletions }))), [pr.files]);
  const threads = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of openThreads(pr)) counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
    return counts;
  }, [pr]);
  return (
    <div data-pr-files className="flex flex-col pt-1.5">
      <FileTree nodes={tree} depth={0} activePath={activePath} threads={threads} onOpenFile={onOpenFile} />
    </div>
  );
}

type TreeProps = { activePath?: string; threads: Map<string, number>; onOpenFile: (path: string) => void };

function FileTree({ nodes, depth, ...rest }: { nodes: DiffTreeNode<Entry>[]; depth: number } & TreeProps) {
  return (
    <>
      {nodes.map((node) => (
        <FileNode key={node.path} node={node} depth={depth} {...rest} />
      ))}
    </>
  );
}

function FileNode({ node, depth, activePath, threads, onOpenFile }: { node: DiffTreeNode<Entry>; depth: number } & TreeProps) {
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
        {!collapsed && <FileTree nodes={node.children} depth={depth + 1} activePath={activePath} threads={threads} onOpenFile={onOpenFile} />}
      </>
    );
  }
  const file = node.file;
  const count = threads.get(file.path);
  return (
    <button
      type="button"
      style={indent}
      data-pr-file={file.path}
      aria-current={activePath === file.path}
      onClick={() => onOpenFile(file.path)}
      className={`flex h-7 w-full items-center gap-1.5 pr-3 text-left text-[12.5px] hover:bg-hover ${activePath === file.path ? "bg-hover" : ""}`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">{icon(File01Icon, 14)}</span>
      <span className="min-w-0 flex-1 truncate text-ink">{node.name}</span>
      {count ? (
        <span
          data-pr-file-threads={count}
          aria-label={`${count} open threads`}
          className="flex shrink-0 items-center gap-0.5 text-[11px] text-orange-ink tabular-nums"
        >
          {icon(Comment01Icon, 12)}
          {count}
        </span>
      ) : null}
      <Counts added={file.additions} removed={file.deletions} />
    </button>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { EASE_OUT, SPRING_LAYOUT } from "../../lib/ease";
import { ScrollArea } from "../primitives/ScrollArea";
import type { DiffFileEntry } from "../../electron";
import { CommentCard, CommentSlot } from "./DiffComments";
import { DiffFile } from "./DiffFile";
import { useCommentDraft, type CommentActions, type CommentStore, type CommentView } from "./useDiffComments";
import type { Changes } from "./useChanges";
import type { useDiffPreferences } from "./DiffPrefs";
import type { PullRequestDetail, PullRequestFile, PullRequestThread, ReviewEvent } from "@milagre/shared/pull-request-review";
import type { DiffSelection } from "../../lib/diff-comments";
import { threadsByPath, threadsFor, viewedCount } from "../../lib/pull-request-view";
import { ReviewBar, ThreadCard, type ThreadActions } from "./PullRequestReview";

/** A PR's diff: GitHub's threads and viewed state on its files, and its review's writes. Every function is stable. */
export type PrDiffReview = {
  pr: PullRequestDetail;
  threadActions: ThreadActions;
  addToReview: (selection: DiffSelection, path: string, body: string) => void;
  toggleViewed: (path: string) => void;
  submit: (event: ReviewEvent, body: string) => Promise<boolean>;
  error: string | null;
};

// The toolbar, preferences and presence live in DiffPrefs, which the app loads up front; this file is its own chunk.
export { DiffToolbar, useDiffPreferences, useDiffPresence } from "./DiffPrefs";

const NO_COMMENTS: CommentView[] = [];

export function DiffView({
  changes,
  prefs,
  comments,
  review,
}: {
  changes: Changes;
  prefs: ReturnType<typeof useDiffPreferences>;
  comments: CommentStore;
  review?: PrDiffReview;
}) {
  const reduced = useReducedMotion();
  const { list, load, patchFor, scrollTarget } = changes;
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledTarget = useRef<typeof scrollTarget>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const files = list.state === "ready" && list.isRepo ? list.files : [];

  useEffect(() => {
    if (!scrollTarget || scrolledTarget.current === scrollTarget) return;
    const node = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-diff-file]") ?? [])].find((el) => el.dataset.diffFile === scrollTarget.path);
    if (node) {
      node.scrollIntoView({ block: "start" });
      scrolledTarget.current = scrollTarget;
    }
  }, [scrollTarget, files]);

  // Stable, so a file only re-renders when its own props change.
  const toggle = useCallback(
    (path: string) =>
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
    [],
  );
  const showLarge = useCallback((file: DiffFileEntry) => load(file, true), [load]);

  const { draft, text, start, over, edit, cancel } = useCommentDraft();
  const { add, update, remove } = comments;
  const addToReview = review?.addToReview;
  // The rows a selection points at mean something else in the other layout.
  useEffect(() => cancel(), [prefs.layout, cancel]);
  const actions = useMemo<CommentActions>(
    () => ({
      start,
      over,
      edit,
      cancel,
      save: (selection, path, body, editing) => {
        if (editing) update(editing, body);
        else if (selection) add({ path, ...selection, body });
        cancel();
      },
      remove: (id) => {
        remove(id);
        cancel();
      },
      ...(addToReview && {
        addToReview: (selection, path, body) => {
          addToReview(selection, path, body);
          cancel();
        },
      }),
    }),
    [start, over, edit, cancel, add, update, remove, addToReview],
  );

  // The PR's threads per file, the same arrays while they don't change, so untouched files don't re-render.
  const threadGroups = useRef<Map<string, PullRequestThread[]>>(undefined);
  const prThreads = useMemo(() => (threadGroups.current = threadsByPath(review?.pr.threads ?? [], threadGroups.current)), [review?.pr.threads, threadGroups]);
  const viewedByPath = useMemo(
    () => new Map<string, PullRequestFile["viewed"]>(review?.pr.files.map((file) => [file.path, file.viewed]) ?? []),
    [review?.pr.files],
  );
  const threadActions = review?.threadActions;
  const renderThreads = useCallback(
    (threads: PullRequestThread[]) => (threadActions ? threads.map((thread) => <ThreadCard key={thread.id} thread={thread} actions={threadActions} />) : null),
    [threadActions],
  );

  // A file whose comments haven't changed gets the same array back, so it doesn't re-render.
  const grouped = useRef(new Map<string, CommentView[]>());
  const byPath = useMemo(() => {
    const next = new Map<string, CommentView[]>();
    for (const comment of comments.comments) next.set(comment.path, [...(next.get(comment.path) ?? []), comment]);
    for (const [path, group] of next) {
      const previous = grouped.current.get(path);
      if (previous && previous.length === group.length && previous.every((comment, index) => comment === group[index])) next.set(path, previous);
    }
    grouped.current = next;
    return next;
  }, [comments.comments, grouped]);
  // Comments on files that left the diff have no file to sit in; they gather at the top so they can still be deleted.
  const paths = new Set(files.map((file) => file.path));
  const orphans = list.state === "ready" && list.isRepo ? comments.comments.filter((comment) => !paths.has(comment.path)) : [];

  return (
    // Slides in from the panel's side like the panel itself, and back out the same way; the chat stays hidden until it's gone.
    <motion.div
      className="relative min-h-0 flex-1"
      initial={{ opacity: 0, x: 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 32 }}
      transition={reduced ? { duration: 0 } : { x: SPRING_LAYOUT, opacity: { duration: 0.2, ease: EASE_OUT } }}
    >
      {/* Starts under the top bar, level with the sidebar and the panel; only the bottom edge fades, while there's more below. */}
      <ScrollArea ref={scroller} data-diff-view className="diff-scroll mt-[var(--window-chrome-height)] h-[calc(100%-var(--window-chrome-height))] px-3 pb-4">
        {files.length === 0 && (
          <p className="py-16 text-center text-[13px] text-ink-3">{list.state === "ready" ? "No changes to show." : "Loading changes…"}</p>
        )}
        {orphans.length > 0 && (
          <div data-diff-orphans className="mb-3 overflow-hidden rounded-card border border-line bg-surface">
            <CommentSlot>
              {orphans.map((comment) => (
                <div key={comment.id} className="flex flex-col gap-1">
                  <span className="truncate font-mono text-[11px] text-ink-3" dir="rtl">
                    <bdi>{comment.path}</bdi>
                  </span>
                  <CommentCard comment={comment} onDelete={() => remove(comment.id)} />
                </div>
              ))}
            </CommentSlot>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {files.map((file) => (
            <DiffFile
              key={file.path}
              file={file}
              patch={patchFor(file)}
              layout={prefs.layout}
              wrap={prefs.wrap}
              comments={byPath.get(file.path) ?? NO_COMMENTS}
              draft={draft?.path === file.path ? draft : null}
              draftText={text}
              actions={actions}
              collapsed={collapsed.has(file.path)}
              onToggle={toggle}
              onVisible={load}
              onShowLarge={showLarge}
              threads={review ? threadsFor(prThreads, file.path) : undefined}
              renderThreads={review ? renderThreads : undefined}
              viewed={viewedByPath.get(file.path)}
              onToggleViewed={review?.toggleViewed}
            />
          ))}
        </div>
        {/* Room under the last file for the review bar that floats over it. */}
        {review && <div aria-hidden className="h-20" />}
      </ScrollArea>
      {review && (
        <ReviewBar
          pending={review.pr.pendingReview?.count ?? 0}
          {...viewedCount(review.pr)}
          canApprove={!review.pr.viewerIsAuthor}
          error={review.error}
          onSubmit={review.submit}
        />
      )}
    </motion.div>
  );
}

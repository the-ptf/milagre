import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { DURATION, EASE_OUT, SPRING_LAYOUT } from "../../lib/ease";
import { ScrollArea } from "../primitives/ScrollArea";
import { EmptyState } from "../primitives/EmptyState";
import { SpinnerRing } from "../primitives/SpinnerRing";
import type { DiffFileEntry } from "../../electron";
import { CommentCard, CommentSlot } from "./DiffComments";
import { DiffFile } from "./DiffFile";
import { useCommentDraft, type CommentActions, type CommentStore, type CommentView } from "./useDiffComments";
import type { Changes } from "./useChanges";
import type { useDiffPreferences } from "./DiffPrefs";
import type { PullRequestDetail, PullRequestThread, ReviewEvent } from "@milagre/shared/pull-request-review";
import type { DiffSelection } from "../../lib/diff-comments";
import { threadsByPath, threadsFor } from "../../lib/pull-request-view";
import { ReviewBar, ThreadCard, type ThreadActions } from "./PullRequestReview";

export type PrDiffReview = {
  pr: PullRequestDetail;
  threadActions: ThreadActions;
  addToReview: (selection: DiffSelection, path: string, body: string) => void;
  submit: (event: ReviewEvent, body: string) => Promise<boolean>;
  error: string | null;
};

export { DiffToolbar, useDiffPreferences, useDiffPresence } from "./DiffPrefs";

const NO_COMMENTS: CommentView[] = [];

const fileNodes = (root: HTMLElement | null) => [...(root?.querySelectorAll<HTMLElement>("[data-diff-file]") ?? [])];

function scrollToFile(root: HTMLElement, node: HTMLElement) {
  node.scrollIntoView({ block: "start" });
  const top = root.getBoundingClientRect().top;
  if (node.getBoundingClientRect().top <= top + 1) return;
  const pinned = fileNodes(root).findLast((file) => file.getBoundingClientRect().top <= top + 1);
  const header = pinned?.querySelector("header");
  if (!pinned || !header) return;
  const edge = header.getBoundingClientRect().bottom;
  const row = [...pinned.querySelectorAll<HTMLElement>("[data-diff-row]")].find((element) => element.getBoundingClientRect().bottom > edge);
  const hidden = row ? edge - row.getBoundingClientRect().top : 0;
  if (hidden > 0) root.scrollTop -= hidden;
}

function holdFile(root: HTMLElement, node: HTMLElement, own: { current: number }) {
  scrollToFile(root, node);
  own.current = root.scrollTop;
}

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

  const holding = useRef<string | null>(null);
  const ownTop = useRef(0);
  useEffect(() => {
    if (!scrollTarget || scrolledTarget.current === scrollTarget) return;
    const node = fileNodes(scroller.current).find((el) => el.dataset.diffFile === scrollTarget.path);
    if (node && scroller.current) {
      holdFile(scroller.current, node, ownTop);
      scrolledTarget.current = scrollTarget;
      holding.current = scrollTarget.path;
    }
  }, [scrollTarget, files]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const release = () => (holding.current = null);
    const observer = new ResizeObserver(() => {
      const node = holding.current && fileNodes(scroller.current).find((el) => el.dataset.diffFile === holding.current);
      if (node) holdFile(element, node, ownTop);
    });
    // Any scroll that isn't the hold's own (the reader's, or code setting scrollTop) lets go of the picked file.
    const moved = () => {
      if (holding.current && Math.abs(element.scrollTop - ownTop.current) > 1) holding.current = null;
    };
    element.addEventListener("scroll", moved, { passive: true });
    for (const child of element.querySelectorAll("[data-diff-file]")) observer.observe(child);
    element.addEventListener("wheel", release, { passive: true });
    element.addEventListener("pointerdown", release);
    element.addEventListener("keydown", release);
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", moved);
      element.removeEventListener("wheel", release);
      element.removeEventListener("pointerdown", release);
      element.removeEventListener("keydown", release);
    };
  }, [files]);
  const { setVisiblePath } = changes;
  useEffect(() => {
    const element = scroller.current;
    if (!element || !setVisiblePath) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (holding.current) return setVisiblePath(holding.current);
      const top = element.getBoundingClientRect().top + 8;
      const nodes = fileNodes(scroller.current);
      const pinned = nodes.findLast((node) => node.getBoundingClientRect().top <= top) ?? nodes[0];
      if (pinned?.dataset.diffFile) setVisiblePath(pinned.dataset.diffFile);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [setVisiblePath, files]);

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

  const threadGroups = useRef<Map<string, PullRequestThread[]>>(undefined);
  const prThreads = useMemo(() => (threadGroups.current = threadsByPath(review?.pr.threads ?? [], threadGroups.current)), [review?.pr.threads, threadGroups]);
  const threadActions = review?.threadActions;
  const renderThreads = useCallback(
    (threads: PullRequestThread[]) => (threadActions ? threads.map((thread) => <ThreadCard key={thread.id} thread={thread} actions={threadActions} />) : null),
    [threadActions],
  );

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
  const paths = new Set(files.map((file) => file.path));
  const orphans = list.state === "ready" && list.isRepo ? comments.comments.filter((comment) => !paths.has(comment.path)) : [];

  return (
    <motion.div
      className="relative min-h-0 flex-1"
      initial={{ opacity: 0, x: 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 32 }}
      transition={reduced ? { duration: 0 } : { x: SPRING_LAYOUT, opacity: { duration: DURATION.base, ease: EASE_OUT } }}
    >
      <ScrollArea ref={scroller} data-diff-view className="diff-scroll mt-[var(--window-chrome-height)] h-[calc(100%-var(--window-chrome-height))] px-3 pb-4">
        {files.length === 0 &&
          (list.state === "ready" ? (
            <EmptyState size="page" title="No changes to show" />
          ) : (
            <p role="status" className="flex items-center justify-center gap-2 py-16 text-13 text-ink-3">
              <SpinnerRing size={12} />
              Loading changes…
            </p>
          ))}
        {orphans.length > 0 && (
          <div data-diff-orphans className="mb-3 overflow-hidden rounded-card border border-line bg-surface">
            <CommentSlot>
              {orphans.map((comment) => (
                <div key={comment.id} className="flex flex-col gap-1">
                  <span className="truncate font-mono text-11 text-ink-3" dir="rtl">
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
            />
          ))}
        </div>
        {review && <div aria-hidden className="h-20" />}
      </ScrollArea>
      {review && (
        <ReviewBar pending={review.pr.pendingReview?.count ?? 0} canApprove={!review.pr.viewerIsAuthor} error={review.error} onSubmit={review.submit} />
      )}
    </motion.div>
  );
}

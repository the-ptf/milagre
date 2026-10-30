import { useEffect, useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Delete02Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { DURATION, EASE_OUT } from "../../lib/ease";
import { labelFor } from "../../lib/diff-comments";
import type { CommentView } from "./useDiffComments";
import { Button, IconButton } from "../primitives/Button";
import { ShortcutKeys } from "../primitives/ShortcutKeys";

/** A quick fade and rise, so a comment doesn't pop into the rows around it. */
function Rise({ children, className, ...rest }: { children: ReactNode; className: string } & Record<`data-${string}`, string | undefined>) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      {...rest}
      initial={reduced ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Sits between diff rows. The code body scrolls sideways, so the slot pins to its left edge and is as wide as the
 * body's visible width (a container query unit) instead of as wide as the longest line.
 */
export function CommentSlot({ children }: { children: ReactNode }) {
  return (
    <div data-diff-comment-slot className="sticky left-0 flex w-[100cqw] flex-col gap-2 bg-surface px-3 py-2 font-sans text-12 whitespace-normal">
      {children}
    </div>
  );
}

export function CommentCard({ comment, onEdit, onDelete }: { comment: CommentView; onEdit?: () => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Rise
      data-diff-comment={comment.id}
      data-outdated={comment.outdated ? "" : undefined}
      className="flex items-start gap-2 rounded-control border border-line bg-inset py-1.5 pr-1.5 pl-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-11">
          <span data-diff-comment-label className="font-mono text-ink-3">
            {labelFor(comment)}
          </span>
          {comment.outdated && (
            <span data-diff-comment-outdated className="text-ink-3">
              Outdated
            </span>
          )}
        </div>
        <button
          type="button"
          data-diff-comment-body
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className={`mt-0.5 block w-full text-left break-words whitespace-pre-wrap ${comment.outdated ? "text-ink-3" : "text-ink"} ${expanded ? "" : "line-clamp-3"}`}
        >
          {comment.body}
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {onEdit && !comment.outdated && <IconButton label="Edit comment" icon={PencilEdit02Icon} size={24} data-diff-comment-edit onClick={onEdit} />}
        <IconButton label="Delete comment" icon={Delete02Icon} size={24} variant="danger-ghost" data-diff-comment-delete onClick={onDelete} />
      </div>
    </Rise>
  );
}

/** `onAddToReview` is a PR's diff: the comment can join the GitHub review, or (Send to Chat) wait for the Chat like any other. */
export function CommentEditor({
  text,
  onSave,
  onCancel,
  onAddToReview,
}: {
  text: MutableRefObject<string>;
  onSave: (body: string) => void;
  onCancel: () => void;
  onAddToReview?: (body: string) => void;
}) {
  const [value, setValue] = useState(text.current);
  const field = useRef<HTMLTextAreaElement>(null);
  const body = value.trim();

  useEffect(() => {
    field.current?.focus({ preventScroll: true });
    field.current?.setSelectionRange(value.length, value.length);
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Grows with the text instead of scrolling inside three rows.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [value]);

  return (
    <Rise data-diff-comment-editor="" className="flex flex-col gap-2">
      <textarea
        ref={field}
        rows={3}
        value={value}
        placeholder="Leave a comment"
        aria-label="Comment"
        data-diff-comment-input
        onChange={(event) => {
          text.current = event.target.value;
          setValue(event.target.value);
        }}
        onKeyDown={(event) => {
          // Stopped here so the app's own Esc (stop the turn) and Enter handling never see it.
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.stopPropagation();
            if (body) (onAddToReview ?? onSave)(body);
          }
        }}
        className="block w-full resize-none rounded-control border border-line-strong bg-field px-2.5 py-2 text-12 text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size={28} data-diff-comment-cancel onClick={onCancel}>
          Cancel
        </Button>
        {onAddToReview && (
          <Button variant="secondary" size={28} data-diff-comment-chat disabled={!body} onClick={() => onSave(body)}>
            Send to Chat
          </Button>
        )}
        <Button size={28} data-diff-comment-save disabled={!body} onClick={() => (onAddToReview ?? onSave)(body)}>
          {onAddToReview ? "Add to review" : "Comment"}
          <ShortcutKeys shortcut="⌘↵" plain className="opacity-70" />
        </Button>
      </div>
    </Rise>
  );
}

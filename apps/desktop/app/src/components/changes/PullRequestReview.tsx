import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkSquare02Icon, Delete02Icon, SparklesIcon, SquareIcon } from "@hugeicons/core-free-icons";
import type { PullRequestThread, ReviewEvent } from "@milagre/shared/pull-request-review";
import { age, threadState } from "../../lib/pull-request-view";
import { Select } from "../primitives/Select";
import { useDismiss } from "../../lib/use-dismiss";

// The PR's review in its diff: GitHub's threads under their lines, each file's Viewed toggle, and the bar that
// submits the viewer's pending review.

const STATE_LABEL = { open: "Open", resolved: "Resolved", outdated: "Outdated", pending: "Pending" } as const;
const STATE_TONE = { open: "text-orange", resolved: "text-ink-3", outdated: "text-ink-3", pending: "text-accent-ink" } as const;

export type ThreadActions = {
  reply: (thread: PullRequestThread, body: string) => Promise<boolean>;
  resolve: (thread: PullRequestThread, resolved: boolean) => void;
  deleteComment: (commentId: string) => void;
  fixInChat: (thread: PullRequestThread) => void;
};

const button =
  "h-7 rounded-control border border-line px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-40";

function Avatar({ login }: { login: string }) {
  return (
    <span aria-hidden className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-hover text-[10px] font-semibold text-ink-2 uppercase">
      {login.slice(0, 1)}
    </span>
  );
}

export function ThreadCard({ thread, actions }: { thread: PullRequestThread; actions: ThreadActions }) {
  const state = threadState(thread);
  const [collapsed, setCollapsed] = useState(state === "resolved" || state === "outdated");
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (replying) field.current?.focus({ preventScroll: true });
  }, [replying]);
  const first = thread.comments[0];
  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const ok = await actions.reply(thread, body);
    setSending(false);
    if (ok) {
      setText("");
      setReplying(false);
    }
  };

  return (
    <div data-pr-thread={thread.id} data-pr-thread-state={state} className="flex flex-col gap-2 rounded-control border border-line bg-inset p-2.5">
      <button type="button" onClick={() => setCollapsed((value) => !value)} className="flex items-center gap-2 text-left text-[11.5px]">
        {first && <Avatar login={first.author} />}
        <span className="font-medium text-ink">{first?.author}</span>
        <span className="text-ink-3">{first ? age(first.createdAt) : ""}</span>
        {thread.comments.length > 1 && <span className="text-ink-3">· {thread.comments.length} comments</span>}
        <span className="flex-1" />
        <span data-pr-thread-label className={`font-medium ${STATE_TONE[state]}`}>
          {STATE_LABEL[state]}
        </span>
      </button>
      {!collapsed && (
        <>
          {thread.comments.map((comment) => (
            <div key={comment.id} data-pr-comment={comment.id} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {comment !== first && (
                  <div className="mb-0.5 flex items-center gap-2 text-[11px] text-ink-3">
                    <span className="font-medium text-ink-2">{comment.author}</span>
                    {age(comment.createdAt)}
                    {comment.pending && <span className="text-accent-ink">Pending</span>}
                  </div>
                )}
                <p className="break-words whitespace-pre-wrap text-ink">{comment.body}</p>
              </div>
              {comment.pending && (
                <button
                  type="button"
                  aria-label="Delete pending comment"
                  data-pr-comment-delete
                  onClick={() => actions.deleteComment(comment.id)}
                  className="flex size-6 shrink-0 items-center justify-center rounded-chip text-ink-3 hover:bg-hover hover:text-ink"
                >
                  <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.8} color="currentColor" />
                </button>
              )}
            </div>
          ))}
          {replying && (
            <textarea
              ref={field}
              rows={2}
              value={text}
              placeholder="Reply"
              aria-label="Reply"
              data-pr-reply-input
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setReplying(false);
                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.stopPropagation();
                  void send();
                }
              }}
              className="block w-full resize-none rounded-control border border-line bg-page px-2.5 py-2 text-[12.5px] leading-[18px] text-ink outline-none placeholder:text-ink-3 focus:border-ink"
            />
          )}
          <div className="flex items-center gap-2">
            {state !== "pending" &&
              (replying ? (
                <button type="button" data-pr-reply-send disabled={!text.trim() || sending} onClick={() => void send()} className={button}>
                  Add to review
                </button>
              ) : (
                <button type="button" data-pr-reply onClick={() => setReplying(true)} className={button}>
                  Reply
                </button>
              ))}
            {state !== "pending" && (
              <button type="button" data-pr-resolve onClick={() => actions.resolve(thread, !thread.resolved)} className={button}>
                {thread.resolved ? "Unresolve" : "Resolve"}
              </button>
            )}
            <span className="flex-1" />
            {state === "open" && (
              <button
                type="button"
                data-pr-fix
                onClick={() => actions.fixInChat(thread)}
                className="inline-flex h-7 items-center gap-1.5 rounded-control px-2 text-[12px] font-semibold text-accent-ink transition-colors hover:bg-hover"
              >
                <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={1.8} color="currentColor" />
                Fix in Chat
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** A PR file's Viewed toggle, in its diff header and its panel row. */
export function ViewedToggle({ viewed, changed, onToggle }: { viewed: boolean; changed?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={viewed}
      data-pr-viewed={viewed ? "on" : changed ? "changed" : "off"}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={`ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-chip px-2 text-[11px] font-medium transition-colors ${
        viewed ? "bg-green-tint text-diff-add" : changed ? "bg-orange-tint text-orange" : "border border-line text-ink-2 hover:bg-hover"
      }`}
    >
      <HugeiconsIcon icon={viewed ? CheckmarkSquare02Icon : SquareIcon} size={12} strokeWidth={1.8} color="currentColor" />
      {changed && !viewed ? "Changed" : "Viewed"}
    </button>
  );
}

const VERDICTS: { value: ReviewEvent; label: string }[] = [
  { value: "COMMENT", label: "Comment" },
  { value: "APPROVE", label: "Approve" },
  { value: "REQUEST_CHANGES", label: "Request changes" },
];

/** Under the PR's diff: what the review holds so far, and Submit review with a verdict and an optional summary. */
export function ReviewBar({
  pending,
  viewed,
  total,
  canApprove,
  error,
  onSubmit,
}: {
  pending: number;
  viewed: number;
  total: number;
  /** GitHub doesn't let a PR's author approve or request changes on it. */
  canApprove: boolean;
  error: string | null;
  onSubmit: (event: ReviewEvent, body: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    () => setOpen(false),
    (target) => Boolean(root.current?.contains(target)) || Boolean(target.closest("[role=listbox]")),
  );
  const verdicts = canApprove ? VERDICTS : VERDICTS.slice(0, 1);
  const submit = async () => {
    setSending(true);
    const ok = await onSubmit(event, body);
    setSending(false);
    if (ok) {
      setBody("");
      setOpen(false);
    }
  };
  const summary = [pending ? `${pending} pending` : "", `${viewed} of ${total} viewed`].filter(Boolean).join(" · ");
  return (
    <div ref={root} data-pr-review-bar className="pointer-events-auto absolute bottom-4 left-1/2 z-20 w-[min(440px,calc(100%-24px))] -translate-x-1/2">
      <div className="overflow-hidden rounded-[22px] border border-line bg-surface shadow-card">
        {open && (
          <div data-pr-review-form className="flex flex-col gap-2 border-b border-line p-3">
            <textarea
              rows={3}
              value={body}
              placeholder="Leave a summary (optional)"
              aria-label="Review summary"
              data-pr-review-body
              onChange={(next) => setBody(next.target.value)}
              onKeyDown={(next) => {
                if (next.key === "Escape") {
                  next.stopPropagation();
                  setOpen(false);
                }
              }}
              className="block w-full resize-none rounded-control border border-line bg-page px-2.5 py-2 text-[12.5px] leading-[18px] text-ink outline-none placeholder:text-ink-3 focus:border-ink"
            />
            <div className="flex items-center gap-2">
              <Select label="Review verdict" value={event} options={verdicts} onChange={setEvent} width={180} />
              <span className="flex-1" />
              <button
                type="button"
                data-pr-review-submit
                disabled={sending || (event === "COMMENT" && !pending && !body.trim())}
                onClick={() => void submit()}
                className="h-8 rounded-control bg-ink px-3 text-[12.5px] font-medium text-surface transition-opacity hover:opacity-85 disabled:opacity-40"
              >
                Submit
              </button>
            </div>
            {error && <p className="text-[12px] text-red">{error}</p>}
          </div>
        )}
        <div className="flex h-11 items-center gap-2.5 pr-1.5 pl-4">
          {pending > 0 && <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />}
          <span data-pr-review-summary className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">
            {summary}
          </span>
          <button
            type="button"
            data-pr-review-open
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="h-8 rounded-full bg-accent px-3.5 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90"
          >
            Submit review
          </button>
        </div>
      </div>
    </div>
  );
}

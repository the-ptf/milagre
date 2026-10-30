import { useEffect, useRef, useState } from "react";
import { Delete02Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import type { PullRequestThread, ReviewEvent } from "@milagre/shared/pull-request-review";
import { age, threadState } from "../../lib/pull-request-view";
import { Button, IconButton } from "../primitives/Button";
import { FIELD_AREA } from "../primitives/Field";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { Select } from "../primitives/Select";
import { useDismiss } from "../../lib/use-dismiss";

// The PR's review in its diff: GitHub's threads under their lines, and the bar that submits the viewer's pending review.

const STATE_LABEL = { open: "Open", resolved: "Resolved", outdated: "Outdated", pending: "Pending" } as const;
const STATE_TONE = { open: "text-orange-ink", resolved: "text-ink-3", outdated: "text-ink-3", pending: "text-accent-ink" } as const;

export type ThreadActions = {
  reply: (thread: PullRequestThread, body: string) => Promise<boolean>;
  resolve: (thread: PullRequestThread, resolved: boolean) => void;
  deleteComment: (commentId: string) => void;
  fixInChat: (thread: PullRequestThread) => void;
};

function Avatar({ login }: { login: string }) {
  return (
    <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-10 font-semibold text-ink-2 uppercase">
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
    <div data-pr-thread={thread.id} data-pr-thread-state={state} className="flex flex-col gap-2 rounded-control border border-line bg-inset p-3">
      <button type="button" onClick={() => setCollapsed((value) => !value)} className="flex items-center gap-2 text-left text-12">
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
                  <div className="mb-0.5 flex items-center gap-2 text-11 text-ink-3">
                    <span className="font-medium text-ink-2">{comment.author}</span>
                    {age(comment.createdAt)}
                    {comment.pending && <span className="text-accent-ink">Pending</span>}
                  </div>
                )}
                <p className="break-words whitespace-pre-wrap text-ink">{comment.body}</p>
              </div>
              {comment.pending && (
                <IconButton
                  label="Delete pending comment"
                  icon={Delete02Icon}
                  size={24}
                  data-pr-comment-delete
                  onClick={() => actions.deleteComment(comment.id)}
                />
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
              className={`${FIELD_AREA} block resize-none outline-none`}
            />
          )}
          <div className="flex items-center gap-2">
            {state !== "pending" &&
              (replying ? (
                <Button variant="secondary" size={28} data-pr-reply-send disabled={!text.trim() || sending} onClick={() => void send()}>
                  Add to review
                </Button>
              ) : (
                <Button variant="secondary" size={28} data-pr-reply onClick={() => setReplying(true)}>
                  Reply
                </Button>
              ))}
            {state !== "pending" && (
              <Button variant="secondary" size={28} data-pr-resolve onClick={() => actions.resolve(thread, !thread.resolved)}>
                {thread.resolved ? "Unresolve" : "Resolve"}
              </Button>
            )}
            <span className="flex-1" />
            {state === "open" && (
              <button
                type="button"
                data-pr-fix
                onClick={() => actions.fixInChat(thread)}
                className="inline-flex h-7 items-center gap-1.5 rounded-control px-2 text-12 font-medium text-accent-ink transition-colors duration-fast hover:bg-hover"
              >
                <Icon icon={SparklesIcon} size={14} />
                Fix in Chat
              </button>
            )}
          </div>
        </>
      )}
    </div>
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
  canApprove,
  error,
  onSubmit,
}: {
  pending: number;
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
  const summary = pending ? `${pending} pending` : "Nothing pending";
  return (
    <div ref={root} data-pr-review-bar className="pointer-events-auto absolute bottom-4 left-1/2 z-20 w-[min(440px,calc(100%-24px))] -translate-x-1/2">
      <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
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
              className={`${FIELD_AREA} block resize-none outline-none`}
            />
            <div className="flex items-center gap-2">
              <Select label="Review verdict" value={event} options={verdicts} onChange={setEvent} width={180} />
              <span className="flex-1" />
              <Button data-pr-review-submit disabled={sending || (event === "COMMENT" && !pending && !body.trim())} onClick={() => void submit()}>
                Submit
              </Button>
            </div>
            <InlineError size={12}>{error}</InlineError>
          </div>
        )}
        <div className="flex h-11 items-center gap-2 pr-1.5 pl-4">
          {pending > 0 && <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />}
          <span data-pr-review-summary className="min-w-0 flex-1 truncate text-13 text-ink-2">
            {summary}
          </span>
          <Button data-pr-review-open aria-expanded={open} onClick={() => setOpen((value) => !value)} className="rounded-full active:scale-press">
            Submit review
          </Button>
        </div>
      </div>
    </div>
  );
}

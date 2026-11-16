import { useMemo, useRef } from "react";
import type { PullRequestThread, ReviewEvent } from "@milagre/shared/pull-request-review";
import type { DiffSelection } from "../../lib/diff-comments";
import { threadFixMessage } from "../../lib/pull-request-view";
import { useEvent } from "../../lib/stable";
import type { PrDiffReview } from "./DiffView";
import type { PullRequestPanelActions } from "./PullRequestPanel";
import type { ThreadActions } from "./PullRequestReview";
import type { Changes } from "./useChanges";
import type { PullRequestReview } from "./usePullRequest";

export function usePrReviewActions({ review, changes, send }: { review: PullRequestReview; changes: Changes; send: (text: string) => void }) {
  const latest = useRef(review);
  latest.current = review;
  const sendFix = useEvent((text: string) => {
    changes.closeDiff();
    send(text);
  });
  const threadActions = useMemo<ThreadActions>(
    () => ({
      reply: async (thread, body) => (await latest.current.write("reply", (pr, cwd, number) => pr.reply({ cwd, number, threadId: thread.id, body }))).ok,
      resolve: (thread, resolved) =>
        void latest.current.write(
          "resolve",
          (pr, cwd) => pr.resolveThread({ cwd, threadId: thread.id, resolved }),
          (current) => ({ ...current, threads: current.threads.map((entry) => (entry.id === thread.id ? { ...entry, resolved } : entry)) }),
        ),
      deleteComment: (commentId) =>
        void latest.current.write(
          "delete",
          (pr, cwd) => pr.deleteComment({ cwd, commentId }),
          (current) => ({
            ...current,
            threads: current.threads
              .map((thread) => ({ ...thread, comments: thread.comments.filter((comment) => comment.id !== commentId) }))
              .filter((thread) => thread.comments.length > 0),
          }),
        ),
      fixInChat: (thread: PullRequestThread) => {
        const pr = latest.current.pr;
        if (pr) sendFix(threadFixMessage(pr, thread));
      },
    }),
    [sendFix],
  );
  const addToReview = useEvent(
    (selection: DiffSelection, path: string, body: string) =>
      void review.write("comment", (pr, cwd, number) =>
        pr.comment({
          cwd,
          number,
          path,
          line: selection.end,
          startLine: selection.start < selection.end ? selection.start : undefined,
          side: selection.side === "old" ? "LEFT" : "RIGHT",
          body,
        }),
      ),
  );
  const submit = useEvent(
    async (event: ReviewEvent, body: string) => (await review.write("submit", (pr, cwd, number) => pr.submitReview({ cwd, number, event, body }))).ok,
  );
  const diffReview: PrDiffReview | undefined =
    changes.mode === "pr" && review.pr ? { pr: review.pr, threadActions, addToReview, submit, error: review.writeError } : undefined;
  const selectFile = changes.selectFile;
  const actions = useMemo<PullRequestPanelActions>(
    () => ({
      openFile: (path) => selectFile(path),
    }),
    [selectFile],
  );
  return { diffReview, actions };
}

import { useMemo, useRef, useState } from "react";
import type { PullRequestThread, ReviewEvent } from "@milagre/shared/pull-request-review";
import type { DiffSelection } from "../../lib/diff-comments";
import { checksFixMessage, stopAskMessage, threadFixMessage } from "../../lib/pull-request-view";
import { useEvent } from "../../lib/stable";
import type { ModelProvider } from "../../model";
import type { PrDiffReview } from "./DiffView";
import type { PullRequestPanelActions } from "./PullRequestPanel";
import type { ThreadActions } from "./PullRequestReview";
import type { Changes } from "./useChanges";
import type { PullRequestReview, ReviewGuideState } from "./usePullRequest";

/**
 * What a PR shown in a Changes panel does: its threads, line comments, viewed marks and review in the diff, the guide's
 * stops in the main column, and "Fix in Chat" / "Ask in Chat" through the Chat it belongs to. A Link Chat's PRs use it;
 * a Project's Chat wires the same pieces in App.
 */
export function usePrReviewActions({
  review,
  guide,
  changes,
  provider,
  send,
  draft,
}: {
  review: PullRequestReview;
  guide: ReviewGuideState;
  changes: Changes;
  provider?: ModelProvider;
  /** Sends a fix to the Chat, as a send from its composer. */
  send: (text: string) => void;
  /** Adds text to the Chat's composer for the user to finish. */
  draft: (text: string) => void;
}) {
  const [guideStop, setGuideStop] = useState(0);
  const guideShowing = changes.guideOpen && Boolean(review.pr && guide.guide);
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
  const toggleViewed = useEvent((path: string) => {
    const file = review.pr?.files.find((entry) => entry.path === path);
    if (!file) return;
    const viewed = file.viewed !== "VIEWED";
    void review.write(
      "viewed",
      (pr, cwd, number) => pr.fileViewed({ cwd, number, path, viewed }),
      (current) => ({ ...current, files: current.files.map((entry) => (entry.path === path ? { ...entry, viewed: viewed ? "VIEWED" : "UNVIEWED" } : entry)) }),
    );
  });
  const submit = useEvent(
    async (event: ReviewEvent, body: string) => (await review.write("submit", (pr, cwd, number) => pr.submitReview({ cwd, number, event, body }))).ok,
  );
  const diffReview: PrDiffReview | undefined =
    changes.mode === "pr" && review.pr ? { pr: review.pr, threadActions, addToReview, toggleViewed, submit, error: review.writeError } : undefined;
  const openGuideStop = useEvent((stop: number) => {
    const written = guide.guide;
    if (!written) return;
    // Moving on from a stop marks it read; past the last one the tour ends, back on the Chat.
    if (guideShowing && stop > guideStop) void guide.markRead(guideStop);
    if (stop >= written.stops.length) {
      changes.closeDiff();
      return;
    }
    setGuideStop(stop);
    changes.openGuide();
  });
  const latestGuide = useRef({ guide, provider });
  latestGuide.current = { guide, provider };
  const selectFile = changes.selectFile;
  const actions = useMemo<PullRequestPanelActions>(
    () => ({
      openFile: (path) => selectFile(path),
      fixChecks: (pr) => sendFix(checksFixMessage(pr, pr.checks)),
      fixThread: (pr, thread) => sendFix(threadFixMessage(pr, thread)),
      openGuide: openGuideStop,
      writeGuide: () => void latestGuide.current.guide.write(latestGuide.current.provider),
    }),
    [selectFile, sendFix, openGuideStop],
  );
  // "Ask in Chat" on a guide stop: the stop goes into the composer, for the question to follow.
  const askAboutStop = useEvent((stop: number) => {
    const pr = review.pr;
    const entry = guide.guide?.stops[stop];
    if (!pr || !entry) return;
    changes.closeDiff();
    draft(stopAskMessage(pr, entry, stop));
  });
  return { guideStop, guideShowing, diffReview, actions, openGuideStop, askAboutStop };
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { PullRequestThread, ReviewEvent } from "@milagre/shared/pull-request-review";
import type { PrDiffReview } from "../components/changes/DiffView";
import type { PullRequestPanelActions } from "../components/changes/PullRequestPanel";
import type { ThreadActions } from "../components/changes/PullRequestReview";
import { useChanges } from "../components/changes/useChanges";
import { useDiffComments } from "../components/changes/useDiffComments";
import { useLocalChanges, usePullRequest } from "../components/changes/usePullRequest";
import { chatKey } from "../lib/agent-runs";
import { bridgeForKey } from "../lib/computer-bridge";
import type { DiffSelection } from "../lib/diff-comments";
import { prRange, threadFixMessage } from "../lib/pull-request-view";
import { useEvent } from "../lib/stable";
import type { AgentSession, PullRequest, Worktree } from "../model";

type PrChoice = { chat: string; number: number };

function usePrReviewActions(prReview: ReturnType<typeof usePullRequest>, fixInChat: (text: string) => void) {
  const latestPr = useRef(prReview);
  latestPr.current = prReview;
  const prThreadActions = useMemo<ThreadActions>(
    () => ({
      reply: async (thread, body) => (await latestPr.current.write("reply", (pr, cwd, number) => pr.reply({ cwd, number, threadId: thread.id, body }))).ok,
      resolve: (thread, resolved) =>
        void latestPr.current.write(
          "resolve",
          (pr, cwd) => pr.resolveThread({ cwd, threadId: thread.id, resolved }),
          (current) => ({ ...current, threads: current.threads.map((entry) => (entry.id === thread.id ? { ...entry, resolved } : entry)) }),
        ),
      deleteComment: (commentId) =>
        void latestPr.current.write(
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
        const pr = latestPr.current.pr;
        if (pr) fixInChat(threadFixMessage(pr, thread));
      },
    }),
    [fixInChat],
  );
  const addToReview = useEvent(
    (selection: DiffSelection, path: string, body: string) =>
      void prReview.write("comment", (pr, cwd, number) =>
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
  const submitPrReview = useEvent(
    async (event: ReviewEvent, body: string) => (await prReview.write("submit", (pr, cwd, number) => pr.submitReview({ cwd, number, event, body }))).ok,
  );
  return { prThreadActions, addToReview, submitPrReview };
}

/**
 * The open Chat's Changes panel and PR. The PR shown is one picked in the panel's menu or a row's chip, else the row's
 * latest open PR (as the phone opens on), else the branch's own. It is read while the panel shows it and while its Chat
 * is open, so the composer's Review pill counts open threads.
 */
export function usePrPanel({
  showGit,
  projectPath,
  selectedSession,
  selectedWorktree,
  chatView,
  branchPullRequests,
  sendPrToChat,
}: {
  showGit: boolean;
  projectPath: string | undefined;
  selectedSession: AgentSession | undefined;
  selectedWorktree: Worktree | undefined;
  chatView: boolean;
  branchPullRequests: Record<string, PullRequest | null>;
  sendPrToChat: (text: string) => void;
}) {
  const branchPr = showGit && selectedWorktree ? (branchPullRequests[selectedWorktree.path] ?? null) : null;
  const prChatKey = projectPath !== undefined && selectedSession ? chatKey(projectPath, selectedSession.id) : null;
  const [prWanted, setPrWanted] = useState(false);
  const [prPick, setPrPick] = useState<PrChoice | null>(null);
  const [rowPr, setRowPr] = useState<PrChoice | null>(null);
  const prNumber = prPick && prPick.chat === prChatKey ? prPick.number : rowPr && rowPr.chat === prChatKey ? rowPr.number : branchPr?.number;
  const prReview = usePullRequest({
    cwd: selectedWorktree?.path,
    number: prNumber,
    active: prWanted || (chatView && Boolean(selectedSession && selectedWorktree && prNumber)),
    bridge: bridgeForKey(prChatKey),
  });
  const changes = useChanges({
    cwd: selectedWorktree?.path,
    base: selectedWorktree?.base,
    chatId: prChatKey,
    available: chatView && showGit && Boolean(selectedSession && selectedWorktree),
    pullRequest: prNumber ? { number: prNumber, range: prRange(prReview.pr) } : undefined,
  });
  const prShown = changes.open && changes.mode === "pr";
  const localChanges = useLocalChanges({ cwd: selectedWorktree?.path, active: prShown, bridge: bridgeForKey(prChatKey) });
  useEffect(() => setPrWanted(prShown), [prShown]);
  const diffComments = useDiffComments(projectPath !== undefined && selectedSession ? chatKey(projectPath, selectedSession.id) : null, changes);
  const fixInChat = useEvent((text: string) => sendPrToChat(text));
  const { prThreadActions, addToReview, submitPrReview } = usePrReviewActions(prReview, fixInChat);
  const prDiffReview: PrDiffReview | undefined =
    changes.mode === "pr" && prReview.pr
      ? { pr: prReview.pr, threadActions: prThreadActions, addToReview, submit: submitPrReview, error: prReview.writeError }
      : undefined;
  const selectFile = changes.selectFile;
  const prPanelActions = useMemo<PullRequestPanelActions>(
    () => ({
      openFile: (path) => selectFile(path),
    }),
    [selectFile],
  );
  return { branchPr, prChatKey, setPrPick, setRowPr, prNumber, prReview, changes, prShown, localChanges, diffComments, prDiffReview, prPanelActions };
}

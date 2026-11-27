import type { PickedIssue } from "@milagre/shared/issue-start";
import { NO_BRANCHES, NO_WORKTREES, NewChatHeader } from "../NewChatHeader";
import { Button } from "../primitives/Button";

/** Under the composer: View checkpoints for a Chat that only keeps its history, and the composer's note. */
export function ComposerFooter({ onViewCheckpoints, note, onRestore }: { onViewCheckpoints?: () => void; note?: string; onRestore?: () => void }) {
  return (
    <>
      {onViewCheckpoints && (
        <Button variant="ghost" onClick={onViewCheckpoints}>
          View checkpoints
        </Button>
      )}
      {note && (
        <p data-composer-note className="mt-1.5 px-2 text-12 text-ink-3">
          {note}
        </p>
      )}
      {note && onRestore && (
        <Button variant="ghost" onClick={onRestore} className="self-start">
          Restore Chat
        </Button>
      )}
    </>
  );
}

/** A new Chat in a Named Link: its Worktrees come from the Link, so only the issue picker is left. */
export function LinkNewChatHeader({ linearActive, onStartFromIssue }: { linearActive?: boolean; onStartFromIssue?: (issue: PickedIssue) => void }) {
  return (
    <NewChatHeader
      link
      worktrees={NO_WORKTREES}
      onWorktreeChange={() => {}}
      isolation="worktree"
      onIsolationChange={() => {}}
      branches={NO_BRANCHES}
      baseBranch=""
      onBaseBranchChange={() => {}}
      linearActive={linearActive}
      onStartFromIssue={onStartFromIssue}
    />
  );
}

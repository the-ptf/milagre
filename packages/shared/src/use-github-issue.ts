import { useEffect, useRef, useState } from "react";
import { ipcErrorMessage } from "./result.mjs";
import type { CoordinatorState } from "./model.ts";
import type { GitHubIssue, GitHubIssueList, GitHubImportTarget } from "./github-issue.mjs";

export type GitHubIssueApi = { list: () => Promise<GitHubIssueList>; read: (url: string) => Promise<GitHubIssue> };

/** A mounted form belongs to one Computer/Project. Late answers after closing or changing it are ignored. */
export function useGitHubIssue(api: GitHubIssueApi) {
  const [list, setList] = useState<GitHubIssueList | null>(null);
  const [issue, setIssue] = useState<GitHubIssue | null>(null);
  const [error, setError] = useState("");
  const [listing, setListing] = useState(true);
  const [reading, setReading] = useState(false);
  const sequence = useRef(0);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    const id = ++sequence.current;
    const life = active;
    let mounted = true;
    void (async () => {
      try {
        const value = await api.list();
        if (mounted) setList(value);
      } catch (failure) {
        if (mounted && id === sequence.current) setError(ipcErrorMessage(failure));
      } finally {
        if (mounted) setListing(false);
      }
    })();
    return () => {
      mounted = false;
      life.current = false;
    };
  }, [api]);
  async function preview(url: string) {
    const id = ++sequence.current;
    setReading(true);
    setIssue(null);
    setError("");
    try {
      const value = await api.read(url);
      if (active.current && id === sequence.current) setIssue(value);
    } catch (failure) {
      if (active.current && id === sequence.current) setError(ipcErrorMessage(failure));
    } finally {
      if (active.current && id === sequence.current) setReading(false);
    }
  }
  function invalidate() {
    sequence.current++;
    setIssue(null);
    setError("");
    setReading(false);
  }
  return { list, issue, error, loading: reading || (listing && !issue), preview, invalidate };
}

export function githubImportTargets(state: CoordinatorState): { value: string; label: string; target: GitHubImportTarget }[] {
  return [
    ...Object.values(state.worktrees)
      .filter((worktree) => !worktree.sharedChat)
      .map((worktree) => ({
        value: `chat:${worktree.id}`,
        label: `New Chat in ${worktree.name}`,
        target: { kind: "chat" as const, worktreeId: worktree.id },
      })),
    ...Object.values(state.sessions)
      .filter((chat) => !chat.archived && !chat.formerWorktree && state.worktrees[chat.worktree_id] && !state.worktrees[chat.worktree_id]!.sharedChat)
      .map((chat) => ({
        value: `existing:${chat.id}`,
        label: `Chat: ${chat.title || `#${chat.id}`} (${state.worktrees[chat.worktree_id]!.name})`,
        target: { kind: "existing" as const, sessionId: chat.id },
      })),
  ];
}

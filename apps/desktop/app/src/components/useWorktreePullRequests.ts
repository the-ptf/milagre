import { preferenceStorage as localStorage } from "../lib/preference-storage.ts";
import { isTurnEnd } from "@milagre/shared/agent-runs";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CoordinatorState, PullRequest } from "../model";
import { chatInProject, sessionIdFromKey } from "../lib/agent-runs";
import { pullRequestRefs, type PullRequestRef } from "../lib/chat-pull-requests";
import { type PullRequestBlocker, updateBlockerDismissals } from "../lib/pr-blockers";
import { bridgeForKey, onAnyAgentEvent } from "../lib/computer-bridge";

// Conflict entries are bare PR URLs, so this key keeps its name from when conflicts were the only blocker.
const DISMISSED_BLOCKERS = "milagre.dismissed-conflict-actions";

const NO_PRS: Record<string, PullRequest | null> = {};
const NO_CHAT_PRS: Record<string, Record<PullRequestRef, PullRequest | null>> = {};
const POLL_MS = 30_000;
const FOCUS_GAP_MS = 5000;

/**
 * Runs `refresh` every `POLL_MS` only while the window is visible and focused. A hidden or blurred window
 * stops its timer (no wake-ups, no gh calls); coming back refreshes once, unless it just did, and resumes.
 */
export function pollWhileActive(refresh: () => void, lastRefresh: () => number): () => void {
  const active = () => document.visibilityState === "visible" && document.hasFocus();
  let interval: number | undefined;
  const stop = () => {
    window.clearInterval(interval);
    interval = undefined;
  };
  const resume = () => {
    if (!active()) return;
    if (Date.now() - lastRefresh() >= FOCUS_GAP_MS) refresh();
    interval ??= window.setInterval(refresh, POLL_MS);
  };
  const pause = () => {
    if (!active()) stop();
  };
  const onVisibility = () => (active() ? resume() : stop());
  if (active()) interval = window.setInterval(refresh, POLL_MS);
  window.addEventListener("focus", resume);
  window.addEventListener("blur", pause);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    stop();
    window.removeEventListener("focus", resume);
    window.removeEventListener("blur", pause);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

// The last PRs read for each Project, by Worktree path, and the last of each chat's own PRs. A Project opened
// again starts from them, so its rows keep their chips while gh answers instead of losing and regaining them.
const lastPullRequests = new Map<string, Record<string, PullRequest | null>>();
const lastChatPullRequests = new Map<string, Record<string, Record<PullRequestRef, PullRequest | null>>>();
// When each Worktree's PRs were read (by `${projectPath}\n${path}`; for chats' PRs, which ones): a Project opened again
// within POLL_MS shows them from above and asks gh only for the rest, leaving them to the poll and turn ends.
const branchReadAt = new Map<string, number>();
const chatReadAt = new Map<string, { at: number; refs: ReadonlySet<PullRequestRef> }>();
const readKey = (projectPath: string, path: string) => `${projectPath}\n${path}`;
const recent = (at: number | undefined) => at !== undefined && Date.now() - at < POLL_MS;

/** PRs stay transient: refresh on opening a project, focus, turn completion, and while visible. */
export function useWorktreePullRequests(projectPath: string, state: CoordinatorState | null) {
  const [dismissedBlockers, setDismissedBlockers] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(DISMISSED_BLOCKERS) ?? "[]");
      return Array.isArray(saved) ? saved.filter((url): url is string => typeof url === "string") : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(DISMISSED_BLOCKERS, JSON.stringify(dismissedBlockers));
    } catch {
      /* Keep working in memory. */
    }
  }, [dismissedBlockers]);
  const dismissBlockerAction = (pr: PullRequest, blocker: PullRequestBlocker) =>
    setDismissedBlockers((current) => updateBlockerDismissals(current, pr, blocker));
  const stateRef = useRef(state);
  stateRef.current = state;
  const [snapshot, setSnapshot] = useState<{ projectPath: string; prs: Record<string, PullRequest | null> }>({ projectPath: "", prs: {} });
  // The Worktrees whose Chats have a message, from each Chat's summary (an older host's state, without one, from its messages).
  const pathsKey = JSON.stringify(
    [
      ...new Set(
        Object.values(state?.sessions ?? {}).every((session) => session.summary)
          ? Object.values(state?.sessions ?? {}).flatMap((session) => {
              const worktree = !session.archived && session.summary!.count > 0 ? state!.worktrees[session.worktree_id] : undefined;
              return worktree ? [worktree.path] : [];
            })
          : (state?.messages.flatMap((message) => {
              const session = state.sessions[message.session_id];
              const worktree = session && !session.archived ? state.worktrees[session.worktree_id] : undefined;
              return worktree ? [worktree.path] : [];
            }) ?? []),
      ),
    ].sort(),
  );

  // An older host (a paired computer not updated yet) has no `pull-requests:snapshot`: read each Worktree as before.
  const [legacyFor, setLegacyFor] = useState<string | null>(null);
  const legacy = legacyFor === projectPath;

  useEffect(() => {
    if (!projectPath || !legacy) return;
    const paths: string[] = JSON.parse(pathsKey);
    let disposed = false;
    let lastRefresh = 0;
    const pending = new Set<string>();
    const refresh = async (selected = paths) => {
      lastRefresh = Date.now();
      await Promise.all(
        selected.map(async (path) => {
          if (pending.has(path)) return;
          pending.add(path);
          try {
            const pr = await bridgeForKey(projectPath)
              .readPullRequest(path)
              .catch(() => null);
            if (!disposed) {
              branchReadAt.set(readKey(projectPath, path), Date.now());
              setDismissedBlockers((current) => updateBlockerDismissals(current, pr));
              setSnapshot((current) => {
                const prs = { ...(current.projectPath === projectPath ? current.prs : (lastPullRequests.get(projectPath) ?? {})), [path]: pr };
                lastPullRequests.set(projectPath, prs);
                return { projectPath, prs };
              });
            }
          } finally {
            pending.delete(path);
          }
        }),
      );
    };
    // Worktrees read moments ago (this Project was open then) keep that answer until the next poll.
    const unread = paths.filter((path) => !recent(branchReadAt.get(readKey(projectPath, path))));
    if (unread.length) void refresh(unread);
    else lastRefresh = Date.now();
    const stopPolling = pollWhileActive(
      () => void refresh(),
      () => lastRefresh,
    );
    const unsubscribe = onAnyAgentEvent(({ chatId, event }) => {
      if (!chatInProject(projectPath, chatId) || !isTurnEnd(event)) return;
      const current = stateRef.current;
      const session = current?.sessions[sessionIdFromKey(chatId)];
      const path = session && current?.worktrees[session.worktree_id]?.path;
      if (path && paths.includes(path)) void refresh([path]);
    });
    return () => {
      disposed = true;
      stopPolling();
      unsubscribe();
    };
  }, [projectPath, pathsKey, legacy]);

  // PRs the chats created or merged, looked up from each chat's folder (numbers resolve in its repository).
  const chatRefs = useMemo(() => {
    const byPath: Record<string, PullRequestRef[]> = {};
    for (const session of Object.values(state?.sessions ?? {})) {
      const worktree = !session.archived ? state?.worktrees[session.worktree_id] : undefined;
      if (!worktree) continue;
      const refs = session.summary
        ? (session.summary.pullRequests ?? [])
        : pullRequestRefs(state!.messages.filter((message) => message.session_id === session.id));
      if (refs.length) byPath[worktree.path] = [...new Set([...(byPath[worktree.path] ?? []), ...refs])];
    }
    return byPath;
    // oxlint-disable-next-line react/preserve-manual-memoization -- the callback reads state?.sessions, state?.worktrees and state!.messages, all listed; the compiler infers the whole state object from the non-null assertion
  }, [state?.messages, state?.sessions, state?.worktrees]);
  const chatRefsKey = JSON.stringify(Object.entries(chatRefs).sort(([a], [b]) => a.localeCompare(b)));
  const [chatSnapshot, setChatSnapshot] = useState<{ projectPath: string; prs: Record<string, Record<PullRequestRef, PullRequest | null>> }>({
    projectPath: "",
    prs: {},
  });
  const chatSnapshotRef = useRef(chatSnapshot);
  chatSnapshotRef.current = chatSnapshot;

  useEffect(() => {
    if (!projectPath || !legacy) return;
    const entries: Array<[string, PullRequestRef[]]> = JSON.parse(chatRefsKey);
    if (!entries.length) return;
    let disposed = false;
    let lastRefresh = 0;
    // A merged PR can't change again, so it's read once; new and open ones follow the branch PR's refreshes. `fresh`
    // leaves out the Worktrees whose PRs were all read moments ago.
    const refresh = async (only?: string, fresh = false) => {
      lastRefresh = Date.now();
      const known = chatSnapshotRef.current.projectPath === projectPath ? chatSnapshotRef.current.prs : (lastChatPullRequests.get(projectPath) ?? {});
      await Promise.all(
        entries.map(async ([path, refs]) => {
          if (only && path !== only) return;
          const selected = refs.filter((ref) => known[path]?.[ref]?.state !== "MERGED");
          if (!selected.length) return;
          const read = chatReadAt.get(readKey(projectPath, path));
          if (fresh && read && recent(read.at) && selected.every((ref) => read.refs.has(ref))) return;
          const prs = await bridgeForKey(projectPath)
            .readPullRequests(path, selected)
            .catch(() => selected.map(() => null));
          if (disposed) return;
          chatReadAt.set(readKey(projectPath, path), { at: Date.now(), refs: new Set(selected) });
          // The composer can offer these PRs' actions too, so their reads clear a fixed blocker's dismissal.
          setDismissedBlockers((current) => prs.reduce((next, pr) => updateBlockerDismissals(next, pr), current));
          setChatSnapshot((current) => {
            const previous = current.projectPath === projectPath ? current.prs : (lastChatPullRequests.get(projectPath) ?? {});
            const read = Object.fromEntries(selected.map((ref, index) => [ref, prs[index] ?? null]));
            const next = { ...previous, [path]: { ...previous[path], ...read } };
            lastChatPullRequests.set(projectPath, next);
            return { projectPath, prs: next };
          });
        }),
      );
    };
    void refresh(undefined, true);
    const stopPolling = pollWhileActive(
      () => void refresh(),
      () => lastRefresh,
    );
    // At a turn end, like the branch PR, so a Chat's PR doesn't show an older status than its branch PR's.
    const unsubscribe = onAnyAgentEvent(({ chatId, event }) => {
      if (!chatInProject(projectPath, chatId) || !isTurnEnd(event)) return;
      const current = stateRef.current;
      const session = current?.sessions[sessionIdFromKey(chatId)];
      const path = session && current?.worktrees[session.worktree_id]?.path;
      if (path) void refresh(path);
    });
    return () => {
      disposed = true;
      stopPolling();
      unsubscribe();
    };
  }, [projectPath, chatRefsKey, legacy]);

  // The host polls GitHub for every client (pull-request-watch.cjs); this reads what it found, which never waits on
  // gh, and again whenever it says the Project's PRs changed. Reading while the window is focused keeps the Project
  // on the host's one-minute cadence.
  useEffect(() => {
    if (!projectPath) return;
    const bridge = bridgeForKey(projectPath);
    let disposed = false;
    let lastRead = 0;
    let reading = false;
    let again = false;
    const read = async () => {
      lastRead = Date.now();
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const found = await bridge.readPullRequestSnapshot(projectPath);
        if (disposed || !found) return;
        const chatPrs = Object.values(found.chats).flatMap((byRef) => Object.values(byRef));
        setDismissedBlockers((current) => [...Object.values(found.worktrees), ...chatPrs].reduce((next, pr) => updateBlockerDismissals(next, pr), current));
        setSnapshot((current) => {
          const prs = { ...(current.projectPath === projectPath ? current.prs : (lastPullRequests.get(projectPath) ?? {})), ...found.worktrees };
          lastPullRequests.set(projectPath, prs);
          return { projectPath, prs };
        });
        setChatSnapshot((current) => {
          const previous = current.projectPath === projectPath ? current.prs : (lastChatPullRequests.get(projectPath) ?? {});
          const prs = { ...previous };
          for (const [path, byRef] of Object.entries(found.chats)) prs[path] = { ...previous[path], ...byRef };
          lastChatPullRequests.set(projectPath, prs);
          return { projectPath, prs };
        });
      } catch (error) {
        if (!disposed && error instanceof Error && /Unknown command/i.test(error.message)) setLegacyFor(projectPath);
      } finally {
        reading = false;
        if (again && !disposed) {
          again = false;
          void read();
        }
      }
    };
    if (legacy) return;
    void read();
    const stopPolling = pollWhileActive(
      () => void read(),
      () => lastRead,
    );
    const unsubscribe = bridge.onPullRequestsChanged((change) => {
      if (change.projectPath === projectPath) void read();
    });
    return () => {
      disposed = true;
      stopPolling();
      unsubscribe();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a Worktree or Chat PR new to the Project is read again: the host polls only what it was asked for
  }, [projectPath, pathsKey, chatRefsKey, legacy]);

  return {
    pullRequests: snapshot.projectPath === projectPath ? snapshot.prs : (lastPullRequests.get(projectPath) ?? NO_PRS),
    chatPullRequests: chatSnapshot.projectPath === projectPath ? chatSnapshot.prs : (lastChatPullRequests.get(projectPath) ?? NO_CHAT_PRS),
    dismissedBlockers,
    dismissBlockerAction,
  };
}

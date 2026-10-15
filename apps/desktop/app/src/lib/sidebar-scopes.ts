import { bridgeForKey } from "./computer-bridge.ts";
import { useCallback, useEffect, useState } from "react";
import type { CoordinatorState, LinkState, OpenProject } from "@milagre/shared/model";
import type { AgentRuns } from "@milagre/shared/agent-runs";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import { isListedChat } from "@milagre/shared/chats";
import { stateEvents } from "./state-events.ts";
import { chatSummary } from "@milagre/shared/chat-summary";
import type { SidebarRecent } from "../components/sidebar/ChatRow";
import { chatMark, chatTitle, orderChats, type ChatOrder } from "./chat-list.ts";

// The last full copy of each Project the sidebar read, so opening one of its chats shows it before the main process answers.
const projectCopies = new Map<string, OpenProject>();
export function cachedProjectCopy(path: string): OpenProject | undefined {
  return projectCopies.get(path);
}
/** The open Project's latest copy, so the group it leaves behind on a switch shows its chats without a reload. */
export function rememberProjectCopy(project: OpenProject) {
  projectCopies.set(project.path, project);
}

/**
 * Chat keys (`<scope>#<id>`, Links included) with a turn streaming, waiting on the user, or asking a question next,
 * each joined by newlines so the memo'd sidebar only re-renders when one changes.
 */
export function runKeys(runs: AgentRuns) {
  const entries = Object.entries(runs);
  const keys = (keep: (run: AgentRuns[string]) => boolean) =>
    entries
      .filter(([, run]) => keep(run))
      .map(([key]) => key)
      .join("\n");
  return {
    running: keys(() => true),
    waiting: keys((run) => run.approvals.length > 0 || run.questions.length > 0),
    asking: keys((run) => run.approvals.length === 0 && run.questions.length > 0),
  };
}

/** The facts only the open Project's rows learn (its PRs, Linear issues and ports are read for it alone). */
type RememberedDetails = Pick<NonNullable<SidebarRecent["details"]>, "pullRequests" | "linearIssue" | "linearKey" | "linkable" | "ports">;
// The last of those facts each chat showed while its Project was open, by scope key then chat id. A Project left
// behind keeps showing them until it is opened again: its rows don't shrink on a switch.
const rememberedDetails = new Map<string, Map<string, { path: string | undefined; details: RememberedDetails }>>();

/** Keeps what the open scope's rows show now, for `scopeChats` to carry once the scope isn't open. */
export function rememberScopeRows(key: string, rows: readonly SidebarRecent[]) {
  const byId = new Map<string, { path: string | undefined; details: RememberedDetails }>();
  for (const row of rows) {
    if (row.pending || !row.details) continue;
    const { pullRequests, linearIssue, linearKey, linkable, ports } = row.details;
    byId.set(row.id, { path: row.details.path, details: { pullRequests, linearIssue, linearKey, linkable, ports } });
  }
  rememberedDetails.set(key, byId);
}

/** What a chat row remembers from when its scope was open, if its chat still has the same Worktree. */
function rememberedFor(key: string, id: string, path: string | undefined): RememberedDetails {
  const remembered = rememberedDetails.get(key)?.get(id);
  return remembered && remembered.path === path ? remembered.details : {};
}

/** What a scope's icon shows on the collapsed rail: a chat asking or waiting wins over one running. */
export type RailStatus = "attention" | "running" | "idle";

/** The chats with a turn under way or waiting on the user, and what the scope's icon shows for them. */
export function railLive(rows: readonly SidebarRecent[]): { status: RailStatus; chats: SidebarRecent[] } {
  const chats = rows.filter((row) => row.mark === "question" || row.mark === "waiting" || row.mark === "delegated" || row.mark === "running");
  const attention = chats.some((row) => row.mark === "question" || row.mark === "waiting");
  return { status: attention ? "attention" : chats.length ? "running" : "idle", chats };
}

/**
 * The chat rows of a Project or Link that isn't open, for the all-Projects sidebar; the marks come from `runKeys`.
 * Each row keeps the PRs, Linear issue and ports it showed while its scope was open (`rememberScopeRows`).
 */
export function scopeChats(
  key: string,
  state: CoordinatorState | LinkState,
  order: ChatOrder,
  { running, waiting, asking }: { running: Set<string>; waiting: Set<string>; asking: Set<string> },
): SidebarRecent[] {
  // Chats carry a summary of their messages; only an older host's state, without one, is read message by message.
  const bySession = new Map<number, CoordinatorState["messages"]>();
  if (Object.values(state.sessions).some((session) => !session.summary))
    for (const message of state.messages) {
      const list = bySession.get(message.session_id);
      if (list) list.push(message);
      else bySession.set(message.session_id, [message]);
    }
  const listed = Object.values(state.sessions)
    .filter((session) => !session.archived)
    .map((session) => ({ session, sessionMessages: bySession.get(session.id) ?? [] }))
    .filter(({ session, sessionMessages }) => isListedChat(session, chatSummary(session, sessionMessages).count));
  return orderChats(listed, order).map(({ session, sessionMessages }) => {
    const worktree = "worktree_id" in session && "worktrees" in state ? state.worktrees[session.worktree_id] : undefined;
    const chatKey = `${key}#${session.id}`;
    return {
      id: String(session.id),
      label: chatTitle(session, sessionMessages),
      pinned: Boolean(session.pinned),
      pinOrder: session.pin_order,
      unread: Boolean(session.unread),
      mark: chatMark({ asking: asking.has(chatKey), waiting: waiting.has(chatKey), running: running.has(chatKey), unread: Boolean(session.unread) }),
      ...("worktrees" in session ? { worktreeCount: session.worktrees.length } : {}),
      details: {
        ...rememberedFor(key, String(session.id), worktree?.path),
        ...(worktree ? { branch: worktree.name, path: worktree.path, diff: worktree.diff } : {}),
        failed: chatSummary(session, sessionMessages).lastOutcome === "failed",
        lastAt: chatSummary(session, sessionMessages).lastAt,
      },
    };
  });
}

/**
 * Loads each scope's state (a Project path or a `milagre-link:` key) once, without opening it, and follows its
 * later changes from live events, so switching Projects reads nothing again. Nothing is read while `enabled` is false.
 */
// Shared by every mounted sidebar (the Project one and a Link's), so the one that mounts on a switch starts full.
const scopeStateCache: Record<string, CoordinatorState | LinkState> = {};
// Keys read once already (or being read). Live events keep them current after that, so a switch re-reads nothing.
const requestedKeys = new Set<string>();
let listening = 0;
// Every mounted hook hears a first read, not only the one that asked: the Chat grid reads none itself.
const readListeners = new Set<(key: string, state: CoordinatorState | LinkState) => void>();

export function useScopeStates(enabled: boolean, keys: string[]) {
  const [states, setStates] = useState<Record<string, CoordinatorState | LinkState>>(() => ({ ...scopeStateCache }));
  // Scopes whose read failed, so the sidebar can say so instead of loading forever.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [attempt, setAttempt] = useState(0);
  const joined = keys.join("\n");

  useEffect(() => {
    if (!enabled) return;
    listening++;
    const keep = (key: string, state: CoordinatorState | LinkState | undefined) => {
      // A state too large to send arrives without its sessions; the last full one stays. Every scope's events are
      // kept, the open one's too, so it is current when a switch puts it back among the others.
      if (!state?.sessions) return;
      scopeStateCache[key] = state;
      setStates((previous) => ({ ...previous, [key]: state }));
      setFailed((previous) => {
        if (!previous.has(key)) return previous;
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    };
    const offProject = stateEvents.onProjectState(({ path, state }) => {
      const copy = projectCopies.get(path);
      if (copy && state?.sessions) projectCopies.set(path, { ...copy, state: state as CoordinatorState });
      keep(path, state);
    });
    const offLink = stateEvents.onLinkState(({ linkId, state }) => keep(`milagre-link:${linkId}`, state));
    readListeners.add(keep);
    return () => {
      offProject();
      offLink();
      readListeners.delete(keep);
      listening--;
      // With no sidebar listening, the copies can go stale: read them again next time. A switch unmounts one
      // sidebar and mounts the other in the same commit, so wait a turn before deciding nobody listens.
      window.setTimeout(() => {
        if (listening === 0) requestedKeys.clear();
      }, 0);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !joined) return;
    for (const key of joined.split("\n")) {
      if (requestedKeys.has(key)) continue;
      requestedKeys.add(key);
      const bridge = bridgeForKey(key);
      const read = isLinkScopeKey(key) ? bridge.readLink(key.slice("milagre-link:".length)) : bridge.readProject(key);
      read.then(
        (opened) => {
          if (!opened.state?.sessions) return;
          if (!isLinkScopeKey(key)) projectCopies.set(key, opened as OpenProject);
          scopeStateCache[key] = opened.state;
          for (const listener of readListeners) listener(key, opened.state);
        },
        () => {
          requestedKeys.delete(key);
          setFailed((previous) => new Set(previous).add(key));
        },
      );
    }
  }, [enabled, joined, attempt]);

  const retry = useCallback((key: string) => {
    setFailed((previous) => {
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
    setAttempt((value) => value + 1);
  }, []);

  return { states, failed, retry };
}

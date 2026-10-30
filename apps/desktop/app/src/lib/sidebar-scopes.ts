import { bridgeForKey } from "./computer-bridge.ts";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { CoordinatorState, LinkState, OpenProject, Routine } from "@milagre/shared/model";
import { clock, triggerText } from "@milagre/shared/routines";
import type { AgentRuns } from "@milagre/shared/agent-runs";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import { seedHeldState, stateEvents } from "./state-events.ts";
import { warmRecentChats } from "./chat-messages.ts";
import { chatSummary } from "@milagre/shared/chat-summary";
import { chatActivity } from "@milagre/shared/chat-activity";
import type { SidebarRecent } from "../components/sidebar/ChatRow";
import { chatMark, chatTitle, isChatListed, orderChats, type ChatOrder } from "./chat-list.ts";
import type { ProjectKind } from "@milagre/shared/chats-home";

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
  const chats = rows.filter(
    (row) => row.mark === "question" || row.mark === "waiting" || row.mark === "delegated" || row.mark === "running" || row.mark === "background",
  );
  const attention = chats.some((row) => row.mark === "question" || row.mark === "waiting");
  return { status: attention ? "attention" : chats.length ? "running" : "idle", chats };
}

/**
 * The chat rows of a Project or Link that isn't open, for the all-Projects sidebar; the marks come from `runKeys`.
 * Each row keeps the PRs, Linear issue and ports it showed while its scope was open (`rememberScopeRows`). A `gitless`
 * scope (a Chats home, whose repository is internal) gives its rows no branch, diff or folder path.
 */
export function scopeChats(
  key: string,
  state: CoordinatorState | LinkState,
  order: ChatOrder,
  { running, waiting, asking }: { running: Set<string>; waiting: Set<string>; asking: Set<string> },
  { gitless = false }: { gitless?: boolean } = {},
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
    // A hidden Run Chat shows only while it waits on an approval or a question.
    .filter(({ session, sessionMessages }) =>
      isChatListed(session, sessionMessages, waiting.has(`${key}#${session.id}`) || asking.has(`${key}#${session.id}`)),
    );
  return orderChats(listed, order).map(({ session, sessionMessages }) => {
    const worktree = "worktree_id" in session && "worktrees" in state ? state.worktrees[session.worktree_id] : undefined;
    const path = gitless ? undefined : (worktree?.path ?? ("workspacePath" in session ? session.workspacePath : undefined));
    const chatKey = `${key}#${session.id}`;
    // A Chat with no run here can still have background agents at work (chat-activity.mjs); its last outcome decides first.
    const { activity, background } = chatActivity(session, undefined, chatSummary(session, sessionMessages).lastOutcome);
    const inBackground = !running.has(chatKey) && activity === "background";
    return {
      id: String(session.id),
      label: chatTitle(session, sessionMessages),
      pinned: Boolean(session.pinned),
      pinOrder: session.pin_order,
      ...(session.done_at ? { doneAt: session.done_at } : {}),
      unread: Boolean(session.unread),
      mark: chatMark({
        asking: asking.has(chatKey),
        waiting: waiting.has(chatKey),
        running: running.has(chatKey),
        background: inBackground,
        unread: Boolean(session.unread),
      }),
      ...(inBackground ? { background } : {}),
      ...("worktrees" in session ? { worktreeCount: session.worktrees.length } : {}),
      details: {
        // A Chats home's Worktree folder is internal: its rows name no folder (the hover card's line, Finder, the editor).
        ...rememberedFor(key, String(session.id), path),
        path,
        ...(worktree && !gitless ? { branch: worktree.name, path: worktree.path, diff: worktree.diff } : {}),
        failed: chatSummary(session, sessionMessages).lastOutcome === "failed",
        lastAt: chatSummary(session, sessionMessages).lastAt,
        firstAt: chatSummary(session, sessionMessages).firstAt,
      },
    };
  });
}

/** One row of the one-list sidebar, with the scope (Project or Link key) it belongs to. */
export type FlatChat = { scopeKey: string; row: SidebarRecent };

/**
 * Every scope's rows as one list: pinned Chats first, by `pinOrder`, then the rest in the Chat order setting: newest
 * Chat first (`created`, by when its first message came) or latest message first (`recent`). Chat and message ids are
 * per Project, so the order across scopes comes from the summary's times. Each scope's rows arrive in the setting's order
 * already and keep it within their scope; the scopes interleave by the time of the row each has next. A row without its
 * time (a Chat the host began tracking before `firstAt`) goes by its latest activity instead. Ties go to the earlier scope.
 * A heap of the scopes keeps this to O(rows × log scopes), where a scan of every scope for every row grew with Chats × Projects.
 */
export function mergeScopeChats(scopes: readonly { key: string; rows: readonly SidebarRecent[] }[], order: ChatOrder): FlatChat[] {
  const merged: FlatChat[] = [];
  const timeOf = (row: SidebarRecent) => (order === "created" ? (row.details?.firstAt ?? row.details?.lastAt) : row.details?.lastAt) ?? 0;
  for (const pinned of [true, false]) {
    const queues = scopes.map(({ key, rows }, index) => ({ key, index, rows: rows.filter((row) => Boolean(row.pinned) === pinned), at: 0 }));
    type Queue = (typeof queues)[number];
    // A row goes before another when it has the lower pin order, else the newer time.
    const first = (a: SidebarRecent, b: SidebarRecent) => (pinned ? (a.pinOrder ?? 0) - (b.pinOrder ?? 0) : timeOf(b) - timeOf(a));
    // The scopes with rows left, as a heap by the row each has next; ties go to the earlier scope.
    const heap = queues.filter((queue) => queue.rows.length);
    const before = (a: Queue, b: Queue) => {
      const rank = first(a.rows[a.at]!, b.rows[b.at]!);
      return rank < 0 || (rank === 0 && a.index < b.index);
    };
    const down = (from: number) => {
      for (let at = from; ;) {
        const left = heap[2 * at + 1];
        const right = heap[2 * at + 2];
        let top = at;
        if (left && before(left, heap[top]!)) top = 2 * at + 1;
        if (right && before(right, heap[top]!)) top = 2 * at + 2;
        if (top === at) return;
        [heap[at], heap[top]] = [heap[top]!, heap[at]!];
        at = top;
      }
    };
    for (let at = (heap.length >> 1) - 1; at >= 0; at--) down(at);
    for (let top = heap[0]; top; top = heap[0]) {
      merged.push({ scopeKey: top.key, row: top.rows[top.at++]! });
      // Its next row sinks from the top to where it goes; a scope with none left makes way.
      if (top.at >= top.rows.length) {
        heap[0] = heap[heap.length - 1]!;
        heap.pop();
      }
      down(0);
    }
  }
  return merged;
}

/** A row of the sidebar's Chats group, with whether its computer is offline (its row stays, dimmed). */
export type ChatsGroupRow = FlatChat & { offline: boolean };

/**
 * The Chats group's rows: every computer's Chats without a Project in one list, in the Chat order setting, the way the
 * one-list sidebar merges Projects. Pinned ones are left to the Pinned section. Empty when no computer has one, which
 * hides the group.
 */
export function chatsSidebarRows(homes: readonly { key: string; offline: boolean; rows: readonly SidebarRecent[] }[], order: ChatOrder): ChatsGroupRow[] {
  const offline = new Set(homes.filter((home) => home.offline).map((home) => home.key));
  return mergeScopeChats(
    homes.map(({ key, rows }) => ({ key, rows: rows.filter((row) => !row.pinned) })),
    order,
  ).map(({ scopeKey, row }) => ({ scopeKey, row, offline: offline.has(scopeKey) }));
}

/**
 * Whether a sidebar Project scope is in fact a computer's Chats home, which only the Chats group lists. The open one
 * says so by its kind before any home has been read; the rest by the homes' keys.
 */
export function isChatsHomeScope(
  key: string,
  { currentKey, currentKind, homeKeys }: { currentKey: string; currentKind?: ProjectKind; homeKeys: ReadonlySet<string> },
): boolean {
  return (key === currentKey && currentKind === "chats") || homeKeys.has(key);
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

/** The last full state the sidebars hold for a scope (a Project path or a `milagre-link:` key), if any. */
export function cachedScopeState(key: string): CoordinatorState | LinkState | undefined {
  return scopeStateCache[key];
}

/**
 * The window opened a scope, or is leaving it, and holds its latest state: the sidebars take that as their read, so the
 * scope's group shows its chats from it instead of reading its whole state again. Live events keep it current after that.
 */
export function seedScopeState(key: string, state: CoordinatorState | LinkState | undefined) {
  if (!state?.sessions || !listening) return;
  requestedKeys.add(key);
  if (scopeStateCache[key] === state) return;
  scopeStateCache[key] = state;
  // As a read's answer would: every sidebar takes it, and one that failed to read it stops saying so.
  for (const listener of readListeners) listener(key, state);
}

export function useScopeStates(enabled: boolean, keys: string[]) {
  const [states, setStates] = useState<Record<string, CoordinatorState | LinkState>>(() => ({ ...scopeStateCache }));
  // Scopes whose read failed, so the sidebar can say so instead of loading forever.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [attempt, setAttempt] = useState(0);
  const joined = keys.join("\n");

  // The Link's and the Project's workspaces stay mounted behind each other (<Activity>), and a hidden sidebar hears no
  // events. Shown again, it takes what the shown one kept meanwhile, before paint, instead of the states it froze with.
  useLayoutEffect(() => {
    if (!enabled) return;
    setStates((previous) =>
      Object.keys(scopeStateCache).some((key) => previous[key] !== scopeStateCache[key]) ? { ...previous, ...scopeStateCache } : previous,
    );
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    listening++;
    const keep = (key: string, state: CoordinatorState | LinkState | undefined) => {
      // A state too large to send arrives without its sessions; the last full one stays. Every scope's events are
      // kept, the open one's too, so it is current when a switch puts it back among the others.
      if (!state?.sessions) return;
      scopeStateCache[key] = state;
      // Another computer's Project: its most recent Chats are copied to this Mac (chat-messages.ts).
      if (!isLinkScopeKey(key)) warmRecentChats(key, state as CoordinatorState);
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
      const beforeRead = scopeStateCache[key];
      const bridge = bridgeForKey(key);
      const read = isLinkScopeKey(key) ? bridge.readLink(key.slice("milagre-link:".length)) : bridge.readProject(key);
      read.then(
        (opened) => {
          if (!opened.state?.sessions) return;
          // The host's next patch applies to this state instead of reading it again (a host that numbers states).
          seedHeldState(key, opened);
          // A live update can arrive before a slow read answers, especially from another computer. Keep that
          // newer state, so the old snapshot doesn't undo pin settings or move the rows back.
          const cached = scopeStateCache[key];
          const state = cached && cached !== beforeRead ? cached : opened.state;
          if (!isLinkScopeKey(key)) projectCopies.set(key, { ...opened, state } as OpenProject);
          scopeStateCache[key] = state;
          for (const listener of readListeners) listener(key, state);
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

/**
 * The Chats enabled heartbeats check back on, one line each: the chat key, a tab, then the row's hover-card line
 * ("Heartbeat · every 15 min · next 10:45"). A string, like runKeys, so the sidebar's memo sees a change only when it changes.
 */
export function heartbeatKeys(routines: readonly Routine[]): string {
  return routines
    .flatMap((routine) => {
      if (!routine.enabled || routine.target.kind !== "chat") return [];
      const next = typeof routine.nextRunAt === "number" ? ` · next ${clock(routine.nextRunAt)}` : "";
      return [`${routine.target.chatId}\tHeartbeat · ${triggerText(routine.trigger)}${next}`];
    })
    .join("\n");
}

/** heartbeatKeys read back: chat key to its hover-card line. */
export function heartbeatLines(keys: string): Map<string, string> {
  return new Map(
    keys
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        return tab === -1 ? [line, "Heartbeat"] : [line.slice(0, tab), line.slice(tab + 1)];
      }),
  );
}

/** A scope's rows with the heartbeat line on each Chat that has one; the rest (and the list, when none has) stay as they are. */
export function withHeartbeats<T extends SidebarRecent>(scopeKey: string, rows: T[], lines: Map<string, string>): T[] {
  if (lines.size === 0) return rows;
  let changed = false;
  const marked = rows.map((row) => {
    const heartbeat = lines.get(`${scopeKey}#${row.id}`);
    if (heartbeat === row.heartbeat) return row;
    changed = true;
    return { ...row, heartbeat };
  });
  return changed ? marked : rows;
}

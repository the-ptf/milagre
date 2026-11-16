import { bridgeForKey } from "./computer-bridge.ts";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { CoordinatorState, LinkState, OpenProject, Routine } from "@milagre/shared/model";
import { clock, triggerText } from "@milagre/shared/routines";
import { isSnoozed } from "@milagre/shared/snooze";
import type { RunStatuses } from "./agent-runs.ts";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import { seedHeldState, stateEvents } from "./state-events.ts";
import { warmRecentChats } from "./chat-messages.ts";
import { chatSummary } from "@milagre/shared/chat-summary";
import { chatActivity } from "@milagre/shared/chat-activity";
import type { SidebarRecent } from "../components/sidebar/ChatRow";
import { chatMark, chatTitle, isChatListed, orderChats, type ChatOrder } from "./chat-list.ts";
import type { ProjectKind } from "@milagre/shared/chats-home";
import { sessionsWithPins, type DevicePins } from "@milagre/shared/chat-pins";

const projectCopies = new Map<string, OpenProject>();
export function cachedProjectCopy(path: string): OpenProject | undefined {
  return projectCopies.get(path);
}
export function rememberProjectCopy(project: OpenProject) {
  projectCopies.set(project.path, project);
}

export function runKeys(runs: RunStatuses) {
  const entries = Object.entries(runs);
  const keys = (keep: (run: RunStatuses[string]) => boolean) =>
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

type RememberedDetails = Pick<NonNullable<SidebarRecent["details"]>, "pullRequests" | "linearIssue" | "linearKey" | "linkable" | "ports">;
const rememberedDetails = new Map<string, Map<string, { path: string | undefined; details: RememberedDetails }>>();

export function rememberScopeRows(key: string, rows: readonly SidebarRecent[]) {
  const byId = new Map<string, { path: string | undefined; details: RememberedDetails }>();
  for (const row of rows) {
    if (row.pending || !row.details) continue;
    const { pullRequests, linearIssue, linearKey, linkable, ports } = row.details;
    byId.set(row.id, { path: row.details.path, details: { pullRequests, linearIssue, linearKey, linkable, ports } });
  }
  rememberedDetails.set(key, byId);
}

function rememberedFor(key: string, id: string, path: string | undefined): RememberedDetails {
  const remembered = rememberedDetails.get(key)?.get(id);
  return remembered && remembered.path === path ? remembered.details : {};
}

export type RailStatus = "attention" | "running" | "idle";

export function railLive(rows: readonly SidebarRecent[]): { status: RailStatus; chats: SidebarRecent[] } {
  const chats = rows.filter(
    (row) => row.mark === "question" || row.mark === "waiting" || row.mark === "delegated" || row.mark === "running" || row.mark === "background",
  );
  const attention = chats.some((row) => row.mark === "question" || row.mark === "waiting");
  return { status: attention ? "attention" : chats.length ? "running" : "idle", chats };
}

const NO_PINS: DevicePins = {};

export function scopeChats(
  key: string,
  state: CoordinatorState | LinkState,
  order: ChatOrder,
  { running, waiting, asking }: { running: Set<string>; waiting: Set<string>; asking: Set<string> },
  { gitless = false, pins = NO_PINS }: { gitless?: boolean; pins?: DevicePins } = {},
): SidebarRecent[] {
  const bySession = new Map<number, CoordinatorState["messages"]>();
  if (Object.values(state.sessions).some((session) => !session.summary))
    for (const message of state.messages) {
      const list = bySession.get(message.session_id);
      if (list) list.push(message);
      else bySession.set(message.session_id, [message]);
    }
  const listed = Object.values(sessionsWithPins<(typeof state.sessions)[string]>(state.sessions, key, pins))
    .filter((session) => !session.archived)
    .map((session) => ({ session, sessionMessages: bySession.get(session.id) ?? [] }))
    .filter(({ session, sessionMessages }) =>
      isChatListed(session, sessionMessages, waiting.has(`${key}#${session.id}`) || asking.has(`${key}#${session.id}`)),
    );
  return orderChats(listed, order).map(({ session, sessionMessages }) => {
    const worktree = "worktree_id" in session && "worktrees" in state ? state.worktrees[session.worktree_id] : undefined;
    const path = gitless ? undefined : (worktree?.path ?? ("workspacePath" in session ? session.workspacePath : undefined));
    const chatKey = `${key}#${session.id}`;
    const { activity, background } = chatActivity(session, undefined, chatSummary(session, sessionMessages).lastOutcome);
    const inBackground = !running.has(chatKey) && activity === "background";
    return {
      id: String(session.id),
      label: chatTitle(session, sessionMessages),
      pinned: Boolean(session.pinned),
      pinOrder: session.pin_order,
      ...(session.done_at ? { doneAt: session.done_at } : {}),
      ...(isSnoozed(session) ? { snoozedUntil: session.snoozed_until } : {}),
      ...("parent" in session && session.parent !== undefined ? { parent: String(session.parent) } : {}),
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

export type FlatChat = { scopeKey: string; row: SidebarRecent };

export function mergeScopeChats(scopes: readonly { key: string; rows: readonly SidebarRecent[] }[], order: ChatOrder): FlatChat[] {
  const merged: FlatChat[] = [];
  const timeOf = (row: SidebarRecent) => (order === "created" ? (row.details?.firstAt ?? row.details?.lastAt) : row.details?.lastAt) ?? 0;
  for (const pinned of [true, false]) {
    const queues = scopes.map(({ key, rows }, index) => ({ key, index, rows: rows.filter((row) => Boolean(row.pinned) === pinned), at: 0 }));
    type Queue = (typeof queues)[number];
    const first = (a: SidebarRecent, b: SidebarRecent) => (pinned ? (a.pinOrder ?? 0) - (b.pinOrder ?? 0) : timeOf(b) - timeOf(a));
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
      if (top.at >= top.rows.length) {
        heap[0] = heap[heap.length - 1]!;
        heap.pop();
      }
      down(0);
    }
  }
  return merged;
}

export type ChatsGroupRow = FlatChat & { offline: boolean };

export function chatsSidebarRows(homes: readonly { key: string; offline: boolean; rows: readonly SidebarRecent[] }[], order: ChatOrder): ChatsGroupRow[] {
  const offline = new Set(homes.filter((home) => home.offline).map((home) => home.key));
  return mergeScopeChats(
    homes.map(({ key, rows }) => ({ key, rows: rows.filter((row) => !row.pinned) })),
    order,
  ).map(({ scopeKey, row }) => ({ scopeKey, row, offline: offline.has(scopeKey) }));
}

export function isChatsHomeScope(
  key: string,
  { currentKey, currentKind, homeKeys }: { currentKey: string; currentKind?: ProjectKind; homeKeys: ReadonlySet<string> },
): boolean {
  return (key === currentKey && currentKind === "chats") || homeKeys.has(key);
}

const scopeStateCache: Record<string, CoordinatorState | LinkState> = {};
const requestedKeys = new Set<string>();
let listening = 0;
const readListeners = new Set<(key: string, state: CoordinatorState | LinkState) => void>();

export function cachedScopeState(key: string): CoordinatorState | LinkState | undefined {
  return scopeStateCache[key];
}

export function seedScopeState(key: string, state: CoordinatorState | LinkState | undefined) {
  if (!state?.sessions || !listening) return;
  requestedKeys.add(key);
  if (scopeStateCache[key] === state) return;
  scopeStateCache[key] = state;
  for (const listener of readListeners) listener(key, state);
}

export function useScopeStates(enabled: boolean, keys: string[]) {
  const [states, setStates] = useState<Record<string, CoordinatorState | LinkState>>(() => ({ ...scopeStateCache }));
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [attempt, setAttempt] = useState(0);
  const joined = keys.join("\n");

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
      if (!state?.sessions) return;
      scopeStateCache[key] = state;
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
          seedHeldState(key, opened);
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

export function heartbeatKeys(routines: readonly Routine[]): string {
  return routines
    .flatMap((routine) => {
      if (!routine.enabled || routine.target.kind !== "chat") return [];
      const next = typeof routine.nextRunAt === "number" ? ` · next ${clock(routine.nextRunAt)}` : "";
      return [`${routine.target.chatId}\tHeartbeat · ${triggerText(routine.trigger)}${next}`];
    })
    .join("\n");
}

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

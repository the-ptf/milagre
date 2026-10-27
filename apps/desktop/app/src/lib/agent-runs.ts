import type { AgentEvent, ChatMessage, CoordinatorState, ModelOption, ModelProvider, PermissionDecision } from "../model";
import { applyRunEvent, chatInProject, chatKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { chatActivity } from "@milagre/shared/chat-activity";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import type { AgentRun, AgentRuns, SentAnswer } from "@milagre/shared/agent-runs";

export type { AgentRun, AgentRuns, SentAnswer } from "@milagre/shared/agent-runs";
export { applyRunEvent, chatInProject, chatKey, lastUserModel, projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";

/** Session ids of the project's chats that wait on at least one approval or question, so the sidebar can mark them. */
export function chatsWaitingForUser(runs: AgentRuns, projectPath: string): Set<number> {
  const waiting = new Set<number>();
  for (const [key, run] of Object.entries(runs)) {
    if ((run.approvals.length > 0 || run.questions.length > 0) && chatInProject(projectPath, key)) waiting.add(sessionIdFromKey(key));
  }
  return waiting;
}

/** Session ids of the project's chats whose next card is a question (approvals show first), so the sidebar can mark them apart. */
export function chatsAskingUser(runs: AgentRuns, projectPath: string): Set<number> {
  const asking = new Set<number>();
  for (const [key, run] of Object.entries(runs)) {
    if (run.approvals.length === 0 && run.questions.length > 0 && chatInProject(projectPath, key)) asking.add(sessionIdFromKey(key));
  }
  return asking;
}

/** Session ids of the project's chats with a turn running, so the sidebar can mark them. */
export function chatsRunning(runs: AgentRuns, projectPath: string): Set<number> {
  return new Set(
    Object.keys(runs)
      .filter((key) => chatInProject(projectPath, key))
      .map(sessionIdFromKey),
  );
}

/**
 * The project's chats whose activity is background (chat-activity.mjs), by session id, with how many background
 * agents still work: their turn ended, and the agents' results will wake them. A failed last turn shows as failed.
 */
export function chatsInBackground(runs: AgentRuns, projectPath: string, sessions: CoordinatorState["sessions"] = {}): Map<number, number> {
  const background = new Map<number, number>();
  for (const session of Object.values(sessions)) {
    const { activity, background: count } = chatActivity(session, runs[chatKey(projectPath, session.id)]);
    if (activity === "background") background.set(session.id, count);
  }
  return background;
}

/** Records what the user sent for a chat's approval or question. Kept on the run, so another chat's request with the same id is untouched. */
export function markAnswered(runs: AgentRuns, chatId: string, requestId: string, decision: SentAnswer): AgentRuns {
  const run = runs[chatId];
  if (!run) return runs;
  return { ...runs, [chatId]: { ...run, answered: { ...run.answered, [requestId]: decision } } };
}

/** The decision sent for an approval, while the agent takes it. */
export function sentDecision(run: AgentRun | undefined, requestId: string): PermissionDecision | null {
  const sent = run?.answered[requestId];
  return sent === "allow" || sent === "allow-for-chat" || sent === "deny" ? sent : null;
}

/** Whether a question's answers were sent or it was dismissed, while the agent takes it. */
export function sentReply(run: AgentRun | undefined, requestId: string): "answered" | "dismissed" | null {
  const sent = run?.answered[requestId];
  return sent === "answered" || sent === "dismissed" ? sent : null;
}

/** Forgets an answer, so the card is pending again (the answer didn't reach the agent). */
export function clearAnswered(runs: AgentRuns, chatId: string, requestId: string): AgentRuns {
  const run = runs[chatId];
  if (!run || !(requestId in run.answered)) return runs;
  const { [requestId]: _forgotten, ...answered } = run.answered;
  return { ...runs, [chatId]: { ...run, answered } };
}

/** The model to use for a chat. A chat bound to a provider never runs another provider's model. */
export function modelForChat(selected: ModelOption, provider: ModelProvider | undefined, messages: ChatMessage[], catalog: ModelOption[]): ModelOption {
  if (!provider || selected.provider === provider) return selected;
  const lastUsed = messages.findLast((message) => catalog.some((option) => option.id === message.model && option.provider === provider));
  return catalog.find((option) => option.id === lastUsed?.model) ?? catalog.find((option) => option.provider === provider) ?? selected;
}

/** `record` (keyed by chat key) with one computer's entries replaced by `next`, a snapshot from it; the others stay. */
export function replaceComputerEntries<T>(record: Record<string, T>, computerId: string, next: Record<string, T>): Record<string, T> {
  const kept = Object.entries(record).filter(([key]) => computerOfKey(key) !== computerId);
  const taken = Object.entries(next ?? {}).filter(([key]) => computerOfKey(key) === computerId);
  return Object.fromEntries([...kept, ...taken]);
}
/** `runs` without a computer's turns: it was removed, or Other computers was turned off. */
export const dropComputerRuns = (runs: AgentRuns, computerId: string) => replaceComputerEntries(runs, computerId, {});

/** Whether an agent event is newer than what its computer's snapshot holds (`taken` is the snapshot's last number per computer). */
export const eventIsNew = (taken: ReadonlyMap<string, number>, chatId: string, seq: number | undefined) =>
  seq === undefined || seq > (taken.get(computerOfKey(chatId)) ?? 0);

/** `record` (keyed by chat key) without the entries of computers outside `known`; this Mac's always stay. Same object when none go. */
export function keepComputers<T>(record: Record<string, T>, known: ReadonlySet<string>): Record<string, T> {
  const entries = Object.entries(record);
  const kept = entries.filter(([key]) => {
    const id = computerOfKey(key);
    return id === LOCAL_COMPUTER || known.has(id);
  });
  return kept.length === entries.length ? record : Object.fromEntries(kept);
}

/**
 * The model the picker shows for an open chat: the one picked in that chat, else the one its last turn ran, else the
 * fallback (the default for new chats). A pick or turn on another provider than the chat's own doesn't count.
 */
export function modelForOpenChat(
  picked: string | undefined,
  provider: ModelProvider | undefined,
  messages: ChatMessage[],
  catalog: ModelOption[],
  fallback: ModelOption,
): ModelOption {
  const usable = (id: string | null | undefined) => catalog.find((option) => option.id === id && (!provider || option.provider === provider));
  const lastUsed = messages.findLast((message) => usable(message.model));
  return usable(picked) ?? usable(lastUsed?.model) ?? modelForChat(fallback, provider, [], catalog);
}

/** An agent event waiting for the next frame: `model` names a starting turn's model, read when the event arrived. */
export interface QueuedRunEvent {
  chatId: string;
  event: AgentEvent;
  model: string;
}

/** `runs` with each queued event applied in the order it arrived, as one state. */
export const applyRunEvents = (runs: AgentRuns, batch: readonly QueuedRunEvent[]) =>
  batch.reduce((next, { chatId, event, model }) => applyRunEvent(next, chatId, event, model), runs);

/**
 * Events that change what the user must see or do now (a turn starts or ends, a card appears or goes, their own message
 * lands): applied at once, with whatever streamed before them, instead of waiting for the next frame.
 */
const URGENT_EVENTS = new Set<AgentEvent["type"]>([
  "message-sent",
  "answers-sent",
  "turn-started",
  "turn-completed",
  "turn-cancelled",
  "turn-failed",
  "permission-request",
  "permission-resolved",
  "question-request",
  "question-resolved",
  "session-started",
  "session-reset",
]);
export const isUrgentRunEvent = (event: AgentEvent) => URGENT_EVENTS.has(event.type);

/** Runs `flush` once, soon; returns a cancel. */
export type FrameScheduler = (flush: () => void) => () => void;

/**
 * The next animation frame, or a 16 ms timer where there is none or the page is hidden. A window macOS occludes stops
 * firing frames while it still counts as visible, so a 100 ms timer races the frame and whichever comes first flushes.
 */
export const nextFrame: FrameScheduler = (flush) => {
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  if (typeof requestAnimationFrame !== "function" || hidden) {
    const timer = setTimeout(flush, 16);
    return () => clearTimeout(timer);
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    flush();
  };
  const frame = requestAnimationFrame(once);
  const timer = setTimeout(once, 100);
  return () => {
    done = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
};

/**
 * Collects items and hands them to `apply` in one batch, in arrival order: at the scheduled flush, or at once when an
 * item is pushed with `now`, or when `flush()` is called (before anything else writes the state the batch feeds).
 */
export function createCoalescer<T>(apply: (batch: T[]) => void, schedule: FrameScheduler = nextFrame) {
  let queue: T[] = [];
  let cancel: (() => void) | null = null;
  const flush = () => {
    cancel?.();
    cancel = null;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    apply(batch);
  };
  return {
    push(item: T, now = false) {
      queue.push(item);
      if (now) flush();
      else cancel ??= schedule(flush);
    },
    flush,
    /** Drops what is queued, without applying it. */
    dispose() {
      cancel?.();
      cancel = null;
      queue = [];
    },
  };
}
export type Coalescer<T> = ReturnType<typeof createCoalescer<T>>;

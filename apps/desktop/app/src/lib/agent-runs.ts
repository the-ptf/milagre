import type { AgentEvent, ChatMessage, CoordinatorState, ModelOption, ModelProvider, PermissionDecision } from "../model";
import { applyRunEvent, chatInProject, chatKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { chatActivity } from "@milagre/shared/chat-activity";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import type { AgentRun, AgentRuns, SentAnswer } from "@milagre/shared/agent-runs";

export type { AgentRun, AgentRuns, SentAnswer } from "@milagre/shared/agent-runs";
export { chatInProject, chatKey, lastUserModel, projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";

export function chatsWaitingForUser(runs: AgentRuns, projectPath: string): Set<number> {
  const waiting = new Set<number>();
  for (const [key, run] of Object.entries(runs)) {
    if ((run.approvals.length > 0 || run.questions.length > 0) && chatInProject(projectPath, key)) waiting.add(sessionIdFromKey(key));
  }
  return waiting;
}

export function chatsAskingUser(runs: AgentRuns, projectPath: string): Set<number> {
  const asking = new Set<number>();
  for (const [key, run] of Object.entries(runs)) {
    if (run.approvals.length === 0 && run.questions.length > 0 && chatInProject(projectPath, key)) asking.add(sessionIdFromKey(key));
  }
  return asking;
}

export function chatsRunning(runs: AgentRuns, projectPath: string): Set<number> {
  return new Set(
    Object.keys(runs)
      .filter((key) => chatInProject(projectPath, key))
      .map(sessionIdFromKey),
  );
}

export function chatsInBackground(runs: AgentRuns, projectPath: string, sessions: CoordinatorState["sessions"] = {}): Map<number, number> {
  const background = new Map<number, number>();
  for (const session of Object.values(sessions)) {
    const { activity, background: count } = chatActivity(session, runs[chatKey(projectPath, session.id)]);
    if (activity === "background") background.set(session.id, count);
  }
  return background;
}

export function markAnswered(runs: AgentRuns, chatId: string, requestId: string, decision: SentAnswer): AgentRuns {
  const run = runs[chatId];
  if (!run) return runs;
  return { ...runs, [chatId]: { ...run, answered: { ...run.answered, [requestId]: decision } } };
}

export function sentDecision(run: AgentRun | undefined, requestId: string): PermissionDecision | null {
  const sent = run?.answered[requestId];
  return sent === "allow" || sent === "allow-for-chat" || sent === "deny" ? sent : null;
}

export function sentReply(run: AgentRun | undefined, requestId: string): "answered" | "dismissed" | null {
  const sent = run?.answered[requestId];
  return sent === "answered" || sent === "dismissed" ? sent : null;
}

export function clearAnswered(runs: AgentRuns, chatId: string, requestId: string): AgentRuns {
  const run = runs[chatId];
  if (!run || !(requestId in run.answered)) return runs;
  const { [requestId]: _forgotten, ...answered } = run.answered;
  return { ...runs, [chatId]: { ...run, answered } };
}

export function modelForChat(selected: ModelOption, provider: ModelProvider | undefined, messages: ChatMessage[], catalog: ModelOption[]): ModelOption {
  if (!provider || selected.provider === provider) return selected;
  const lastUsed = messages.findLast((message) => catalog.some((option) => option.id === message.model && option.provider === provider));
  return catalog.find((option) => option.id === lastUsed?.model) ?? catalog.find((option) => option.provider === provider) ?? selected;
}

export function replaceComputerEntries<T>(record: Record<string, T>, computerId: string, next: Record<string, T>): Record<string, T> {
  const kept = Object.entries(record).filter(([key]) => computerOfKey(key) !== computerId);
  const taken = Object.entries(next ?? {}).filter(([key]) => computerOfKey(key) === computerId);
  return Object.fromEntries([...kept, ...taken]);
}
export const dropComputerRuns = (runs: AgentRuns, computerId: string) => replaceComputerEntries(runs, computerId, {});

export const eventIsNew = (taken: ReadonlyMap<string, number>, chatId: string, seq: number | undefined) =>
  seq === undefined || seq > (taken.get(computerOfKey(chatId)) ?? 0);

export function keepComputers<T>(record: Record<string, T>, known: ReadonlySet<string>): Record<string, T> {
  const entries = Object.entries(record);
  const kept = entries.filter(([key]) => {
    const id = computerOfKey(key);
    return id === LOCAL_COMPUTER || known.has(id);
  });
  return kept.length === entries.length ? record : Object.fromEntries(kept);
}

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

export interface QueuedRunEvent {
  chatId: string;
  event: AgentEvent;
  model: string;
}

export const applyRunEvents = (runs: AgentRuns, batch: readonly QueuedRunEvent[]) =>
  batch.reduce((next, { chatId, event, model }) => applyRunEvent(next, chatId, event, model), runs);

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

export type FrameScheduler = (flush: () => void) => () => void;

/**
 * The next animation frame, or a 16 ms timer where there is none or the page is hidden. A window macOS occludes stops
 * firing frames while it still counts as visible, so a 100 ms timer races the frame and whichever comes first flushes.
 */
const nextFrame: FrameScheduler = (flush) => {
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
    dispose() {
      cancel?.();
      cancel = null;
      queue = [];
    },
  };
}

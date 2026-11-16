import { chatTitle } from "@milagre/shared/chats";
import type { AgentQuestion, AgentSession, QuestionAnswers, PermissionDecision } from "@milagre/shared/model";
import {
  sortSubchats,
  subchatState,
  type SubchatInput,
  type SubchatKind,
  type SubchatRequest,
  type SubchatState,
  type SubchatSummary,
} from "@milagre/shared/subchat-states";

export type HeartbeatRoutine = {
  enabled: boolean;
  completedAt?: number;
  nextRunAt?: number | null;
  runCount: number;
  maxRuns?: number;
  target: { kind: string; chatId?: string };
};

export function subchatStates(input: {
  keys: readonly string[];
  deeper?: readonly string[];
  sessions: Record<number, AgentSession | undefined>;
  runs: Record<string, SubchatInput["run"]> | undefined;
  routines: readonly HeartbeatRoutine[];
  routinesOn: boolean;
  reports: ReadonlyMap<string, string>;
  now: number;
}): SubchatState[] {
  const states: SubchatState[] = [];
  const deeper = new Set(input.deeper);
  for (const key of [...input.keys, ...deeper]) {
    const session = input.sessions[Number(key.slice(key.lastIndexOf("#") + 1))];
    if (!session) continue;
    const heartbeat = input.routinesOn
      ? input.routines.find((routine) => routine.enabled && !routine.completedAt && routine.target.kind === "chat" && routine.target.chatId === key)
      : undefined;
    const state = subchatState(
      {
        key,
        title: chatTitle(session, []),
        session,
        run: input.runs?.[key],
        heartbeat: heartbeat && { nextRunAt: heartbeat.nextRunAt ?? undefined, runCount: heartbeat.runCount, maxRuns: heartbeat.maxRuns },
        report: input.reports.get(key),
      },
      input.now,
    );
    if (!deeper.has(key)) states.push(state);
    else if (state.kind === "needs-you") {
      const above = session.parent === undefined ? undefined : input.sessions[session.parent];
      states.push({ ...state, ...(above ? { via: chatTitle(above, []) } : {}) });
    }
  }
  return sortSubchats(states);
}

export function pillSpoken(summary: SubchatSummary): string {
  return `Subchats, ${summary.parts.map((part) => part.text).join(", ")}`;
}

export const KIND_TONE: Record<SubchatKind, "orange" | "red" | "accent" | "purple" | "green" | "ink3"> = {
  "needs-you": "orange",
  failed: "red",
  working: "accent",
  holding: "purple",
  queued: "ink3",
  stopped: "ink3",
  done: "green",
};

const RECOMMENDED = /\s*\((recommended)\)\s*$/i;

export function isRecommended(label: string): boolean {
  return RECOMMENDED.test(label);
}

export function inlineQuestion(request: SubchatRequest | undefined): { question: AgentQuestion; options: string[] } | null {
  if (request?.kind !== "question" || request.questions.length !== 1) return null;
  const question = request.questions[0];
  if (!question || question.multiSelect || question.secret || !question.options.length) return null;
  const labels = question.options.map((option) => option.label);
  return { question, options: [...labels.filter(isRecommended), ...labels.filter((label) => !isRecommended(label))] };
}

export function answerArguments(chatId: string, request: Extract<SubchatRequest, { kind: "question" }>, question: AgentQuestion, label: string) {
  const answers: QuestionAnswers = { [question.id]: [label] };
  return { chatId, requestId: request.requestId, answers, summary: `${question.header || question.question}: ${label}` };
}

export function approvalArguments(chatId: string, request: Extract<SubchatRequest, { kind: "approval" }>, decision: PermissionDecision) {
  return { chatId, requestId: request.request.requestId, decision };
}

export function askLines(summary: SubchatSummary): { title: string; rest: string; ask: string; key: string } | null {
  if (!summary.asking) return null;
  const rest = summary.parts
    .filter((part) => part.kind !== "needs-you")
    .map((part) => part.text)
    .join(" · ");
  return { title: summary.asking.title, rest, ask: summary.asking.ask, key: summary.asking.key };
}

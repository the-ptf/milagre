// What the Subchats pill and its panel show (subchat-pill.tsx), made from what the phone already reads: the Project's
// sessions and runs, the Mac's Heartbeats and the Delegation reports in the open Chat's transcript. The states
// themselves are the shared model's (subchat-states.ts), the same one desktop's pill uses.
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

/** The Heartbeats a Chat can hold, from the Mac's Routines (use-routines.ts). */
export type HeartbeatRoutine = {
  enabled: boolean;
  completedAt?: number;
  nextRunAt?: number | null;
  runCount: number;
  maxRuns?: number;
  target: { kind: string; chatId?: string };
};

/**
 * Every direct Subchat's state, what needs the user first. `routinesOn` is the Mac's Routines switch: with it off nothing
 * beats, so a listed Heartbeat promises nothing. The phone has no Delegation feed, so none is ever "queued".
 */
export function subchatStates(input: {
  keys: readonly string[];
  sessions: Record<number, AgentSession | undefined>;
  runs: Record<string, SubchatInput["run"]> | undefined;
  routines: readonly HeartbeatRoutine[];
  routinesOn: boolean;
  reports: ReadonlyMap<string, string>;
  now: number;
}): SubchatState[] {
  const states: SubchatState[] = [];
  for (const key of input.keys) {
    const session = input.sessions[Number(key.slice(key.lastIndexOf("#") + 1))];
    if (!session) continue;
    const heartbeat = input.routinesOn
      ? input.routines.find((routine) => routine.enabled && !routine.completedAt && routine.target.kind === "chat" && routine.target.chatId === key)
      : undefined;
    states.push(
      subchatState(
        {
          key,
          title: chatTitle(session, []),
          session,
          run: input.runs?.[key],
          heartbeat: heartbeat && { nextRunAt: heartbeat.nextRunAt ?? undefined, runCount: heartbeat.runCount, maxRuns: heartbeat.maxRuns },
          report: input.reports.get(key),
        },
        input.now,
      ),
    );
  }
  return sortSubchats(states);
}

/** The pill's spoken name: its parts as a sentence. */
export function pillSpoken(summary: SubchatSummary): string {
  return `Subchats, ${summary.parts.map((part) => part.text).join(", ")}`;
}

/** The ink of a kind's dot and icon: the status colors, the accent for live work. */
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

/** Whether an option is the one the agent recommends: it ends in "(Recommended)". */
export function isRecommended(label: string): boolean {
  return RECOMMENDED.test(label);
}

/**
 * The buttons a row can answer with itself: the options of a request that is one single-choice question, the
 * recommended one first. A request with several questions, several picks or a typed answer opens the Subchat instead.
 */
export function inlineQuestion(request: SubchatRequest | undefined): { question: AgentQuestion; options: string[] } | null {
  if (request?.kind !== "question" || request.questions.length !== 1) return null;
  const question = request.questions[0];
  if (!question || question.multiSelect || question.secret || !question.options.length) return null;
  const labels = question.options.map((option) => option.label);
  return { question, options: [...labels.filter(isRecommended), ...labels.filter((label) => !isRecommended(label))] };
}

/** The arguments of `agent:answer-question` for one pick, summarized as the Chat's own question card does. */
export function answerArguments(chatId: string, request: Extract<SubchatRequest, { kind: "question" }>, question: AgentQuestion, label: string) {
  const answers: QuestionAnswers = { [question.id]: [label] };
  return { chatId, requestId: request.requestId, answers, summary: `${question.header || question.question}: ${label}` };
}

/** The arguments of `agent:respond-permission` for one decision. */
export function approvalArguments(chatId: string, request: Extract<SubchatRequest, { kind: "approval" }>, decision: PermissionDecision) {
  return { chatId, requestId: request.request.requestId, decision };
}

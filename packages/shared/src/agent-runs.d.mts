import type {
  AgentEvent,
  AnsweredQuestion,
  ChatStep,
  ContextUsage,
  ImageAttachment,
  CoordinatorState,
  TranscriptState,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  QuestionAnswers,
  QuestionRequest,
  Subagent,
} from "./model.ts";

export type SentAnswer = PermissionDecision | "answered" | "dismissed";

export interface AgentRun {
  turnId?: string | null;
  text: string;
  model: string;
  permissionMode?: PermissionMode;
  /** Milliseconds since epoch; absent from older hosts. */
  startedAt?: number;
  /** Tool steps in the order they started; each one's offset is where it sits in `text`. */
  steps: ChatStep[];
  /** Approval requests the turn waits on, oldest first. */
  approvals: PermissionRequest[];
  /** Questions the turn waits on, oldest first. */
  questions: QuestionRequest[];
  /** What was sent for each approval or question (by request id) until the agent takes it. */
  answered: Record<string, SentAnswer>;
  split?: boolean;
  steered?: boolean;
  waitingForSubagents?: boolean;
  contextUsage?: ContextUsage;
}

export type AgentRuns = Record<string, AgentRun>;

export type AppliedEvent<T = CoordinatorState> = { state: T; runs: AgentRuns; changed: boolean };

export const MAX_OUTPUT: number;
export function capOutput(text: string): string;
export function lastUserModel(state: TranscriptState, sessionId: number): string;
export function chatKey(projectPath: string, sessionId: number, computerId?: string): string;
export { computerOfKey } from "./chat-scopes.mjs";
export function sessionIdFromKey(key: string): number;
export function projectOfKey(key: string): string;
export function chatInProject(projectPath: string, key: string): boolean;
export function startRun(runs: AgentRuns, chatId: string, model: string, permissionMode?: PermissionMode): AgentRuns;
export function isTurnEnd(event: AgentEvent): boolean;
export function subagentActive(agent: Pick<Subagent, "status"> | undefined): boolean;
export function runStatus(run: AgentRun | undefined): "idle" | "working" | "waiting";
export function applyRunEvent(runs: AgentRuns, chatId: string, event: AgentEvent, model?: string): AgentRuns;
export function applyAgentEvent<T extends TranscriptState>(state: T, runs: AgentRuns, projectPath: string, chatId: string, event: AgentEvent): AppliedEvent<T>;
export function splitRunForSteer<T extends TranscriptState>(state: T, runs: AgentRuns, projectPath: string, chatId: string): AppliedEvent<T>;
export function recordAnswers<T extends TranscriptState>(
  state: T,
  runs: AgentRuns,
  projectPath: string,
  chatId: string,
  body: string,
  answered?: AnsweredQuestion[] | null,
  images?: ImageAttachment[],
): { state: T; runs: AgentRuns; messageId: number | null };
export function answeredQuestions(request: QuestionRequest | undefined, answers: QuestionAnswers | null): AnsweredQuestion[] | null;

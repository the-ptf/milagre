import type {
  AgentEvent,
  AnsweredQuestion,
  ChatStep,
  ContextUsage,
  CoordinatorState,
  TranscriptState,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  QuestionAnswers,
  QuestionRequest,
  Subagent,
} from "./model.ts";

/** What the user sent for a request the turn waits on: an approval decision, or a question answered or dismissed. */
export type SentAnswer = PermissionDecision | "answered" | "dismissed";

/** A turn streaming in a chat, keyed by chat key (see `chatKey`). */
export interface AgentRun {
  /** The provider turn whose completion can supply a follow-up suggestion. */
  turnId?: string | null;
  text: string;
  model: string;
  /** The permission mode the turn started in; a Chat started for another Chat (MCP, Delegation) has no saved pick of its own. */
  permissionMode?: PermissionMode;
  /** When this turn began, in milliseconds since epoch. Older hosts may omit it. */
  startedAt?: number;
  /** Tool steps in the order they started; each one's offset is where it sits in `text`. */
  steps: ChatStep[];
  /** Approval requests the turn waits on, oldest first. */
  approvals: PermissionRequest[];
  /** Questions the turn waits on, oldest first. */
  questions: QuestionRequest[];
  /** What was sent for each approval or question (by request id) until the agent takes it. */
  answered: Record<string, SentAnswer>;
  /** A steering message split the reply, so a turn that ends with nothing more to show saves nothing more. */
  split?: boolean;
  /** A steering message came in and the agent hasn't written text then gone back to its tools since. */
  steered?: boolean;
  /** The agent waits on its subagents, so the indicator says so instead of "Working". */
  waitingForSubagents?: boolean;
  /** How full the agent's context window is; saved on the chat when the turn ends. */
  contextUsage?: ContextUsage;
}

export type AgentRuns = Record<string, AgentRun>;

export type AppliedEvent<T = CoordinatorState> = { state: T; runs: AgentRuns; changed: boolean };

export const MAX_OUTPUT: number;
export function capOutput(text: string): string;
export function lastUserModel(state: TranscriptState, sessionId: number): string;
export function chatKey(projectPath: string, sessionId: number, computerId?: string): string;
export { LOCAL_COMPUTER, computerOfKey, qualifyKey, unqualifyKey } from "./chat-scopes.mjs";
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
): { state: T; runs: AgentRuns; messageId: number | null };
export function answeredQuestions(request: QuestionRequest | undefined, answers: QuestionAnswers | null): AnsweredQuestion[] | null;

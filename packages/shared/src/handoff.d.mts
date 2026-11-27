import type { ChatMessage, ModelProvider, TranscriptState } from "./model.ts";

export type HandoffContext = {
  kind: "handoff";
  from: { provider: ModelProvider; model?: string };
  to: { provider: ModelProvider; model?: string };
  status: "preparing" | "done" | "failed";
  brief?: string;
  transcriptPath?: string;
};

type HandoffState = Pick<TranscriptState, "sessions" | "messages">;

export function isHandoff(message: ChatMessage | undefined): message is ChatMessage & { context: HandoffContext };
/** Dividers whose status is "failed" (a handoff that did not happen) are ignored here and in `catchUpStart`. */
export function lastTurnProvider(state: HandoffState, sessionId: number): ModelProvider | undefined;
export function catchUpStart(state: HandoffState, sessionId: number, provider: ModelProvider): number | null;
export function handoffKind(state: HandoffState, sessionId: number, provider: ModelProvider): "switch" | "restore" | null;

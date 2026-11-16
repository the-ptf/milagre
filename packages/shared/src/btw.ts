import type { ChatStep, EffortLevel, ModelProvider } from "./model.js";

export interface BtwState {
  requestId: string;
  chatId: string;
  question: string;
  text: string;
  steps: ChatStep[];
  status: "running" | "completed" | "failed" | "cancelled";
  error?: string;
  provider: ModelProvider;
  model: string;
  startedAt: number;
  endedAt?: number;
}

export interface BtwRequest {
  chatId: string;
  prompt: string;
  provider?: ModelProvider;
  model?: string;
  effort?: EffortLevel;
}

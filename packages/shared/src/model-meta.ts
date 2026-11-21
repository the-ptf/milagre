/** What a provider reports about a model besides its name and efforts. */
export interface ModelMeta {
  /** Kiro only: the model's credit multiplier, relative to Auto (2 means a turn costs twice what Auto would). */
  credits?: number;
  /** Ollama only: the context window the local server runs the model with, in tokens. */
  contextWindow?: number;
}

export interface ContextUsage {
  used: number;
  size: number;
  /** Ollama only, after a turn: how fast that turn ran on the local model. */
  metrics?: TurnMetrics;
}

/** Ollama only: how the last turn ran on the local model, measured by the host. */
export interface TurnMetrics {
  /** From sending the message to the model's first streamed token, in ms. */
  ttftMs?: number;
  /** Output tokens per second while the model generated. */
  outputTps?: number;
  /** Prompt tokens per second while the model read what it hadn't cached (prefill). */
  prefillTps?: number;
  /** The last model call's prompt, cached tokens included. */
  inputTokens?: number;
  outputTokens?: number;
  /** Model calls in the turn: one, plus one after each round of tool calls. */
  calls?: number;
  durationMs?: number;
}

/** What a provider reports about a model besides its name and efforts. */
export interface ModelMeta {
  /** Kiro only: the model's credit multiplier, relative to Auto (2 means a turn costs twice what Auto would). */
  credits?: number;
  /** Pi only: the model's context window, in tokens (for Ollama, the one the local server runs it with). */
  contextWindow?: number;
  /** Pi only: the provider behind the model (Ollama, OpenRouter, Groq), shown as a heading in the picker. */
  group?: string;
  /** Pi only: the model runs on this computer, through Ollama. */
  local?: boolean;
}

export interface ContextUsage {
  used: number;
  size: number;
  /** Pi only, after a local model's turn: how fast that turn ran. */
  metrics?: TurnMetrics;
  /** Pi only: what the Chat's Pi session has cost so far on paid models, in US dollars. */
  cost?: number;
}

/** Pi's local models only: how the last turn ran, measured by the host. */
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

import type { ContextUsage } from "./model";
export interface ContextSettings {
  buttonThreshold: number;
  autoThreshold: number;
  autoCompact: boolean;
  /** A message sent while a turn runs: steer it, or wait for the turn to end. */
  followUps: "now" | "queue";
}
export const CONTEXT_DEFAULTS: Readonly<ContextSettings>;
export const CONTEXT_GRADIENT_COLORS: [string, string, string, string];
export const CONTEXT_GRADIENT_STOPS: [number, number, number, number];
export const CONTEXT_GRADIENT: string;
export function normalizeContextSettings(value: unknown): ContextSettings;
export function shouldAutoCompact(settings: ContextSettings, usage?: ContextUsage): boolean;

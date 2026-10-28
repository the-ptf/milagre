import type { BabysitStoppedContext, ChatMessage } from "./model.ts";

export type BabysitWake = "comments" | "checks" | "conflicts" | "behind";
export type BabysitLevel = 1 | 2 | 3 | 4 | 5;
export type BabysitStep = "report" | "fix" | "push" | "reply" | "rerequest";

export interface BabysitSettings {
  enabled: boolean;
  intervalMinutes: number;
  wake: BabysitWake[];
  level: BabysitLevel;
  resolveThreads: boolean;
  stopWhenGreen: boolean;
  /** An off rule keeps its number, so turning it back on restores it. */
  stopAfterDays: { on: boolean; days: number };
  stopAfterFailures: { on: boolean; times: number };
  ownRule: boolean;
  ownRuleText: string;
  instructions: string;
}

export interface BabysitLevelInfo {
  level: BabysitLevel;
  title: string;
  description: string;
  steps: readonly BabysitStep[];
}

export const INTERVAL_OPTIONS: readonly number[];
export const DAYS_OPTIONS: readonly number[];
export const FAILURE_OPTIONS: readonly number[];
export const BABYSIT_LEVELS: readonly BabysitLevelInfo[];
export const BABYSIT_DEFAULTS: Readonly<BabysitSettings>;

/** Any stored or received value as complete, valid settings: unknown keys dropped, each bad value reset to its default. */
export function normalizeBabysitSettings(value: unknown): BabysitSettings;

/** The line a Chat shows when its PR's babysit Heartbeat ended: "Stopped babysitting PR #1: merged." */
export function babysitStoppedText(context: BabysitStoppedContext): string;
export function isBabysitStopped(message: ChatMessage | null | undefined): message is ChatMessage & { context: BabysitStoppedContext };

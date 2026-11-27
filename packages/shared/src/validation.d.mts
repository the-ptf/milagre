import type { ChatMessage } from "./model.ts";

export type ValidationRunStatus = "running" | "passed" | "failed" | "not-run" | "interrupted";
export type ValidationResultStatus = ValidationRunStatus | "queued";

/** A command from Settings › Project › Validation. `cwd` is relative to the Worktree; empty is its root. */
export interface ValidationCommand {
  name: string;
  command: string;
  cwd: string;
}

export interface ValidationSettings {
  commands: ValidationCommand[];
  afterTask: boolean;
}

/** One command of a run, as Milagre ran it: its exit code or signal, never what an agent said about it. */
export interface ValidationResult {
  name: string;
  command: string;
  cwd: string;
  status: ValidationResultStatus;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  reason?: string;
  /** The end of its output, at most 40 lines; the whole log is on the host (validation:log). */
  tail?: string;
  hasLog?: boolean;
}

/**
 * A validation run's record in its Chat. `code` is the Worktree's state when it started: HEAD plus a digest of the files
 * that differ from it. `stale` is set once files changed after the run.
 */
export interface ValidationContext {
  kind: "validation";
  runId: string;
  status: ValidationRunStatus;
  trigger: "task" | "user" | "agent";
  startedAt: number;
  endedAt?: number;
  worktreePath: string;
  code?: { head: string | null; dirty: number; digest: string };
  reason?: string;
  results: ValidationResult[];
  stale?: { at: number; files: string[] };
}

export const VALIDATION_LIMITS: Readonly<{ commands: number; name: number; command: number; cwd: number; tailLines: number; tailChars: number }>;
export const VALIDATION_COPY: Readonly<{
  title: string;
  commands: { label: string; description: string };
  afterTask: { label: string; description: string };
  name: { label: string; placeholder: string };
  command: { label: string; placeholder: string };
  cwd: { label: string; placeholder: string };
  add: string;
  empty: string;
}>;
export const VALIDATION_RESULT_WORDS: Readonly<Record<ValidationResultStatus, string>>;
export function normalizeValidationSettings(value: unknown): ValidationSettings;
export function isValidationDone(status: string): boolean;
export function validationStatus(results: ValidationResult[], options?: { running?: boolean; interrupted?: boolean }): ValidationRunStatus;
export function isValidation(message: ChatMessage | null | undefined): message is ChatMessage & { context: ValidationContext };
export function formatValidationDuration(ms: number): string;
export function validationTitle(context: ValidationContext): string;
export function validationMeta(context: ValidationContext): string;
export function validationText(context: ValidationContext): string;
export function validationExit(result: ValidationResult): string;
export function validationStaleText(stale: ValidationContext["stale"]): string;
export function validationAgentNote(context: ValidationContext): string;
export function validationFixPrompt(context: ValidationContext): string;

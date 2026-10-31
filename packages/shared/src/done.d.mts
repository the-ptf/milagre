export interface DoneSettings {
  /** How long a Chat stays in the Done list before the host archives it; 0 is never. */
  retentionHours: number;
}

type DoneSession = { done_at?: number; archived?: boolean };

export const DONE_RETENTION_OPTIONS: readonly number[];
export const DONE_DEFAULTS: Readonly<DoneSettings>;
export function normalizeDoneSettings(value: unknown): DoneSettings;
export function retentionLabel(hours: number): string;
export function isDone(session: DoneSession | undefined | null): boolean;
export function doneDueAt(session: DoneSession, retentionHours: number): number | null;
export function doneDue(session: DoneSession, retentionHours: number, now?: number): boolean;
export function doneCountdown(session: DoneSession, retentionHours: number, now?: number): string | null;
export function byDoneAt(a: { done_at?: number }, b: { done_at?: number }): number;

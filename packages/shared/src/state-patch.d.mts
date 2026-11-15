export type StatePatch = { v: unknown } | { o: Record<string, StatePatch>; d?: string[] } | { a: number; s: Record<string, StatePatch> };

/** What turns `previous` into `next`; undefined when they are the same object. Below `depth` levels, values go whole. */
export function diffState(previous: unknown, next: unknown, depth?: number): StatePatch | undefined;

export function applyStatePatch<T>(previous: T, patch: StatePatch | undefined): T;

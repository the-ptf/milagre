export function originId(url: unknown): string | null;
export function groupByOrigin<T extends { origin?: string | null; computerId: string }>(choices: T[]): Array<T & { copies: T[] }>;
export function copiesToTry<T extends { online?: boolean; offline?: boolean }>(copies: readonly T[], picked: T, isHere: (copy: T) => boolean): T[];
export function openFirstCopy<T, R>(
  copies: readonly T[],
  open: (copy: T) => Promise<R | undefined>,
  failure: (copy: T, error: unknown) => string,
): Promise<{ copy: T | undefined; failures: string[]; stopped: boolean }>;
export function copyOpenNotice(failures: readonly string[], openedOn?: string): string | null;

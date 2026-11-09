export function originId(url: unknown): string | null;
export function groupByOrigin<T extends { origin?: string | null; computerId: string }>(choices: T[]): Array<T & { copies: T[] }>;

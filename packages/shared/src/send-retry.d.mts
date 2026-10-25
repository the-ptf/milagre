export const SEND_RETRY_DELAYS: readonly number[];
export const SEND_RETRY_BUDGET: number;
export const READ_RETRY_BUDGET: number;
export type RetryKind = "unsent" | "unknown";
export function retryKind(error: unknown): RetryKind | null;
export function retrySend<T>(
  attempt: () => Promise<T>,
  options: {
    retryable: (error: unknown) => boolean;
    delays?: readonly number[];
    budget?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  },
): Promise<T>;

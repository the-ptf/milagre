export type GitCode = "NO_ORIGIN" | "DETACHED" | "DETACHED_COMMIT" | "GH_MISSING" | "WORKTREE_CHANGED";
export const GIT_CODES: Readonly<{ [C in GitCode]: C }>;
export const GIT_MESSAGES: Readonly<Record<GitCode, string>>;
export function gitMessage(code: GitCode, platform?: string): string;

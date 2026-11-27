import type { ChatSendRequest, PullRequestActionContext, PullRequestBlocker } from "./model.ts";

export const PR_ACTIONS: Record<PullRequestBlocker, { label: string; sentence: string; skill: string }>;
export function pullRequestActionContext(request: unknown): PullRequestActionContext | null;
export function pullRequestActionBody(context: PullRequestActionContext): string;
export function pullRequestActionRequest(context: (PullRequestActionContext & { projectId?: string }) | undefined): ChatSendRequest["prAction"];
export function pullRequestActionPrompt(context: PullRequestActionContext): string;
export function isPullRequestAction(context: unknown): context is PullRequestActionContext;

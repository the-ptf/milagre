import type { LinearIssue } from "./linear.ts";
import type { LinearIssueContext, LinearIssueSnapshot } from "./model.ts";

export function issueFirstMessage(issue: Pick<LinearIssue, "key" | "title" | "url" | "description">, typed?: string): string;
export function linearIssueRequest(request: unknown): { key: string; workspace?: string; note?: string } | null;
export function linearIssueContext(issue: LinearIssue, note?: string): LinearIssueContext;
export function linearIssuePrompt(issue: Pick<LinearIssue, "key" | "title" | "url" | "description">, note?: string): string;
export function isLinearIssueContext(context: unknown): context is LinearIssueContext;
/** The card a Linear Routine's Run opens its Chat with, carrying the Run and the label "Routine · <name>". */
export function routineIssueContext(
  issue: LinearIssueSnapshot,
  routine: { routineId: string; runId: string; name: string; at: number },
): LinearIssueContext & { routine: NonNullable<LinearIssueContext["routine"]> };

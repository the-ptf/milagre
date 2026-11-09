import type { AgentSession, Subagent, SubagentTranscriptEntry } from "./model.ts";

export const TRANSCRIPT_TAIL: number;
export const TRANSCRIPT_LIMIT: number;
/** `agent` with only the last entries of its transcript; the same object for the same agent. */
export function withTranscriptTail<T extends Subagent>(agent: T): T;
/** `session` with each subagent's transcript cut to its tail; the same object for the same session. */
export function sessionWithTranscriptTails<T extends Pick<AgentSession, "subagents">>(session: T): T;
/** An archived `agent` as a summary (no prompt, latest activity or transcript), the same object each time; any other agent as it is. */
export function withArchivedSummary<T extends Subagent>(agent: T): T;
/** `session` with each archived subagent as a summary; the same object for the same session. */
export function sessionWithArchivedSummaries<T extends Pick<AgentSession, "subagents">>(session: T): T;
/** Whether `agent` is an archived subagent's summary, whose details are read on demand. */
export function isSubagentSummary(agent: Pick<Subagent, "detailsOnDemand"> | undefined): boolean;
/** Whether `agent` carries only the tail of its transcript. */
export function hasTranscriptTail(agent: Pick<Subagent, "transcriptLength"> | undefined): boolean;
/** The whole transcript `held` brought up to date with `agent`'s; null when it must be read again. */
export function mergeTranscript(held: readonly SubagentTranscriptEntry[], agent: Subagent): SubagentTranscriptEntry[] | null;

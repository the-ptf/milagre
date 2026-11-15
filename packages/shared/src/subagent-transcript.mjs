export const TRANSCRIPT_TAIL = 4;
export const TRANSCRIPT_LIMIT = 100;

const tails = new WeakMap();
/** `agent` with only the last entries of its transcript; the same object for the same agent. */
export function withTranscriptTail(agent) {
  if (!Array.isArray(agent?.transcript) || agent.transcript.length <= TRANSCRIPT_TAIL) return agent;
  let tail = tails.get(agent);
  if (!tail) tails.set(agent, (tail = { ...agent, transcript: agent.transcript.slice(-TRANSCRIPT_TAIL), transcriptLength: agent.transcript.length }));
  return tail;
}

const sessions = new WeakMap();
/** `session` with each subagent's transcript cut to its tail; the same object for the same session. */
export function sessionWithTranscriptTails(session) {
  if (!session?.subagents?.some((agent) => agent !== withTranscriptTail(agent))) return session;
  let lean = sessions.get(session);
  if (!lean) sessions.set(session, (lean = { ...session, subagents: session.subagents.map(withTranscriptTail) }));
  return lean;
}

const summaries = new WeakMap();
/** An archived `agent` as a summary, the same object for the same agent; any other agent as it is. */
export function withArchivedSummary(agent) {
  if (!agent?.archived) return agent;
  let summary = summaries.get(agent);
  if (!summary) {
    const { prompt: _prompt, latestActivity: _activity, communications: _communications, transcript: _transcript, transcriptLength: _length, ...rest } = agent;
    summaries.set(agent, (summary = { ...rest, transcript: [], detailsOnDemand: true }));
  }
  return summary;
}

const summarizedSessions = new WeakMap();
/** `session` with each archived subagent as a summary; the same object for the same session. */
export function sessionWithArchivedSummaries(session) {
  if (!session?.subagents?.some((agent) => agent?.archived)) return session;
  let lean = summarizedSessions.get(session);
  if (!lean) summarizedSessions.set(session, (lean = { ...session, subagents: session.subagents.map(withArchivedSummary) }));
  return lean;
}

export const isSubagentSummary = (agent) => agent?.detailsOnDemand === true;

export const hasTranscriptTail = (agent) => typeof agent?.transcriptLength === "number";

/**
 * The whole transcript `held` brought up to date with `agent`'s (a tail, or the whole of a short one): an entry already
 * held is replaced in place, a new one goes at the end. Null when the result can't be the host's (it holds fewer
 * entries than the host says), so the caller reads it again.
 */
export function mergeTranscript(held, agent) {
  if (!hasTranscriptTail(agent)) return agent?.transcript ?? [];
  const merged = [...new Map([...held, ...agent.transcript].map((entry) => [entry.id, entry])).values()].slice(-TRANSCRIPT_LIMIT);
  const tail = merged.slice(-agent.transcript.length);
  const same = merged.length === agent.transcriptLength && tail.every((entry, index) => entry === agent.transcript[index]);
  return same ? merged : null;
}

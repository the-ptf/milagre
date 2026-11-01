import type { AgentSession, LinkedWork, Routine } from "../model";
import type { AgentRun } from "./agent-runs";
import { sessionIdFromKey } from "@milagre/shared/agent-runs";
import { chatTitle } from "@milagre/shared/chats";
import { directSubchats, subchatState, type SubchatInput, type SubchatState } from "@milagre/shared/subchat-states";

/** What the Subchats pill reads from the open Chat, besides its Heartbeats (a hook of its own) and its transcript. */
export interface SubchatSource {
  /** The open Chat's key. */
  parentKey: string;
  /** The Project's sessions, where its Subchats are found. */
  sessions: Record<string, AgentSession> | undefined;
  /** Every live run, by Chat key. */
  runs: Readonly<Record<string, AgentRun | undefined>>;
  /** The Delegations open across Links and inside the Project; a queued one makes its target Chat queued. */
  work: Pick<LinkedWork, "delegations">;
}

/**
 * The state of each direct Subchat of `parentKey` for the Subchats pill: its session, live run, queued Delegation,
 * enabled Heartbeat and last report to the parent, read the way the sidebar reads them.
 */
export function subchatStates({
  parentKey,
  sessions,
  runs,
  work,
  routines,
  reports,
  now,
}: SubchatSource & {
  routines: readonly Pick<Routine, "enabled" | "target" | "nextRunAt" | "runCount" | "maxRuns">[];
  /** The latest report each Chat sent into the parent's transcript, by Chat key (latestReports). */
  reports: ReadonlyMap<string, string>;
  now: number;
}): SubchatState[] {
  const states: SubchatState[] = [];
  for (const key of directSubchats(sessions, parentKey)) {
    const session = sessions?.[sessionIdFromKey(key)];
    if (!session) continue;
    const heartbeat = routines.find((routine) => routine.enabled && routine.target.kind === "chat" && routine.target.chatId === key);
    const input: SubchatInput = {
      key,
      title: chatTitle(session),
      session,
      run: runs[key] ?? null,
      queued: work.delegations.some((delegation) => delegation.to_chat === key && delegation.status === "queued"),
      heartbeat: heartbeat ? { nextRunAt: heartbeat.nextRunAt ?? undefined, runCount: heartbeat.runCount, maxRuns: heartbeat.maxRuns } : null,
      report: reports.get(key),
    };
    states.push(subchatState(input, now));
  }
  return states;
}

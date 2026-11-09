import type { AgentSession, LinkedWork, Routine } from "../model";
import type { AgentRun } from "./agent-runs";
import { sessionIdFromKey } from "@milagre/shared/agent-runs";
import { chatTitle } from "@milagre/shared/chats";
import { deeperSubchats, directSubchats, subchatState, type SubchatInput, type SubchatKind, type SubchatState } from "@milagre/shared/subchat-states";

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

type StateExtras = {
  routines: readonly Pick<Routine, "enabled" | "target" | "nextRunAt" | "runCount" | "maxRuns">[];
  /** The latest report each Chat sent into the parent's transcript, by Chat key (latestReports). */
  reports: ReadonlyMap<string, string>;
  now: number;
};

/** The words of each state as text: the matching ink token, which holds contrast on the surface. */
export const KIND_INK: Record<SubchatKind, string> = {
  "needs-you": "text-orange-ink",
  failed: "text-red-ink",
  working: "text-accent-ink",
  holding: "text-purple-ink",
  queued: "text-ink-3",
  stopped: "text-ink-3",
  done: "text-green-ink",
};

/** One Chat's state, read the way the sidebar reads it: its session, live run, queued Delegation, Heartbeat and last report. */
export function chatState(key: string, { sessions, runs, work, routines, reports, now }: Omit<SubchatSource, "parentKey"> & StateExtras): SubchatState | null {
  const session = sessions?.[sessionIdFromKey(key)];
  if (!session) return null;
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
  return subchatState(input, now);
}

/**
 * The state of each Subchat of `parentKey` for the Subchats pill: its direct ones, oldest first, then the Subchats of
 * those at any depth, each naming the Chat that delegated to it (`via`), so a question two levels down still shows here.
 */
export function subchatStates({ parentKey, sessions, runs, work, routines, reports, now }: SubchatSource & StateExtras): SubchatState[] {
  const states: SubchatState[] = [];
  const read = { sessions, runs, work, routines, reports, now };
  for (const key of directSubchats(sessions, parentKey)) {
    const state = chatState(key, read);
    if (state) states.push(state);
  }
  for (const key of deeperSubchats(sessions, parentKey)) {
    const state = chatState(key, read);
    const parent = sessions?.[sessionIdFromKey(key)]?.parent;
    const via = parent === undefined ? undefined : sessions?.[parent];
    if (state) states.push(via ? { ...state, via: chatTitle(via) } : state);
  }
  return states;
}

/** How many of the Chat's Subchats, at any depth, wait on an answer or an approval: an unfocused split tile's "1 needs you". */
export function subchatsNeedingYou(sessions: SubchatSource["sessions"], runs: SubchatSource["runs"], parentKey: string): number {
  if (!sessions) return 0;
  const read = { sessions, runs, work: { delegations: [] }, routines: [], reports: new Map<string, string>(), now: 0 };
  return [...directSubchats(sessions, parentKey), ...deeperSubchats(sessions, parentKey)].filter((key) => chatState(key, read)?.kind === "needs-you").length;
}

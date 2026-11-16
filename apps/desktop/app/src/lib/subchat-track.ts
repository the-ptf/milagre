import type { AgentSession, LinkedWork, Routine } from "../model";
import type { AgentRun } from "./agent-runs";
import { sessionIdFromKey } from "@milagre/shared/agent-runs";
import { chatTitle } from "@milagre/shared/chats";
import { deeperSubchats, directSubchats, subchatState, type SubchatInput, type SubchatKind, type SubchatState } from "@milagre/shared/subchat-states";

export interface SubchatSource {
  parentKey: string;
  sessions: Record<string, AgentSession> | undefined;
  runs: Readonly<Record<string, AgentRun | undefined>>;
  work: Pick<LinkedWork, "delegations">;
}

type StateExtras = {
  routines: readonly Pick<Routine, "enabled" | "target" | "nextRunAt" | "runCount" | "maxRuns">[];
  reports: ReadonlyMap<string, string>;
  now: number;
};

export const KIND_INK: Record<SubchatKind, string> = {
  "needs-you": "text-orange-ink",
  failed: "text-red-ink",
  working: "text-accent-ink",
  holding: "text-purple-ink",
  queued: "text-ink-3",
  stopped: "text-ink-3",
  done: "text-green-ink",
};

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

export function subchatsNeedingYou(sessions: SubchatSource["sessions"], runs: SubchatSource["runs"], parentKey: string): number {
  if (!sessions) return 0;
  const read = { sessions, runs, work: { delegations: [] }, routines: [], reports: new Map<string, string>(), now: 0 };
  return [...directSubchats(sessions, parentKey), ...deeperSubchats(sessions, parentKey)].filter((key) => chatState(key, read)?.kind === "needs-you").length;
}
